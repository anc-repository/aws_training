#!/usr/bin/env bash
# scripts/release-docker/build.sh — build every release artifact in Docker (amazonlinux:2023), no AWS call, nothing uploaded.
#
#   bash scripts/release-docker/build.sh [--ref <git ref>] [--version <cloudalbum version>] [--out <dir>] [--work <dir>]
#        [--cache <dir>] [--no-arm64] [--overlay] [--skip-images] [--keep] [-- <extra platform:package args>]
#
# Runs on any Docker host (Windows Git Bash, macOS, Linux). Steps (logs in <work>/logs/):
#   1. builder images atl-release-builder:{amd64,arm64} (Dockerfile.builder; arm64 through QEMU / binfmt when the Docker
#      host has it — otherwise the arm64 archive and the arm64 node_modules are skipped and the reason is recorded)
#   2. `git bundle` of <ref> (default HEAD): the build sees committed sources only, never the working tree, so the release is
#      reproducible from a commit. --overlay adds the uncommitted files of the release tooling paths (for testing it).
#   3. amd64 container: npm ci, build, frontend, platform/web, labs:build, check bundle (SOURCE_DATE_EPOCH = commit time, so
#      the check bundle digest of the CloudAlbum archives equals the platform release's), scripts/release (x86_64)
#   4. arm64 container: scripts/release --from-prepared (arm64), node_modules for the workstation and the runner
#   5. amd64 container: npm run platform:package with both archives and the node_modules, then preflight --artifacts-only
# Results: <out>/app/cloudalbum-<ver>-<arch>.tgz(.sha256), <out>/v<platform version>/ (the GitHub Release layout + SHA256SUMS +
# package-report.json), <out>/build-report.json. Defaults: <out> = dist/release, <work> = dist/release-work,
# <cache> = dist/release-cache (all git-ignored; keep them on a disk with space: ~3 GB while building).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
ref=HEAD; version=''; out="$ROOT/dist/release"; work="$ROOT/dist/release-work"; cache="$ROOT/dist/release-cache"
arm64=yes; overlay=no; images=yes; keep=no; extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --work) work=$2; shift 2 ;;
    --cache) cache=$2; shift 2 ;;
    --no-arm64) arm64=no; shift ;;
    --overlay) overlay=yes; shift ;;
    --skip-images) images=no; shift ;;
    --keep) keep=yes; shift ;;
    --) shift; extra=("$@"); break ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done
[ -z "$version" ] || [[ $version =~ ^[A-Za-z0-9._-]+$ ]] || { echo "--version: [A-Za-z0-9._-]+ only" >&2; exit 64; }

# Git Bash rewrites /-paths in arguments of Windows programs: off for docker only (git and node need the rewriting)
dk() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker "$@"; }
hostpath() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }   # D:/… on Windows, /… elsewhere
mkdir -p "$out" "$work" "$cache/npm-amd64" "$cache/npm-arm64"
rm -rf "$work/in" "$work/tools" "$work/logs"; mkdir -p "$work/in" "$work/tools" "$work/logs"
rm -f "$work"/prepared.tar "$work"/ws-src.tar.gz "$work"/*node_modules-linux-*.tar.gz* "$work"/VERSION "$work"/COMMIT "$work"/SOURCE_DATE_EPOCH
OUT_H=$(hostpath "$out"); WORK_H=$(hostpath "$work"); CACHE_H=$(hostpath "$cache")
started=$(date -u +%Y-%m-%dT%H:%M:%SZ); t0=$(date +%s)
step() { printf '\n== %s  %s\n' "$(date +%H:%M:%S)" "$*"; }

dk info >/dev/null 2>&1 || { echo "build.sh: Docker is not running" >&2; exit 1; }
commit=$(git -C "$ROOT" rev-parse --verify "$ref^{commit}")
epoch=$(git -C "$ROOT" log -1 --format=%ct "$commit")

# 1. images
image() {  # <platform> <tag>
  if [ "$images" = yes ] || ! dk image inspect "atl-release-builder:$2" >/dev/null 2>&1; then
    dk build --platform "$1" -f "$(hostpath "$HERE")/Dockerfile.builder" -t "atl-release-builder:$2" "$(hostpath "$HERE")" > "$work/logs/image-$2.log" 2>&1 \
      || { tail -20 "$work/logs/image-$2.log" >&2; return 1; }
  fi
}
step "builder images"
image linux/amd64 amd64
base_digest=$(dk image inspect amazonlinux:2023 --format '{{index .RepoDigests 0}}' 2>/dev/null || true)
arm64_reason=''
if [ "$arm64" = yes ]; then
  if ! m=$(dk run --rm --platform linux/arm64 amazonlinux:2023 uname -m 2>"$work/logs/qemu.log") || [ "$m" != aarch64 ]; then
    arm64=no; arm64_reason="the Docker host cannot run linux/arm64 containers (QEMU / binfmt missing): $(tail -1 "$work/logs/qemu.log")"
  elif ! image linux/arm64 arm64; then
    arm64=no; arm64_reason="building the arm64 builder image failed (logs/image-arm64.log)"
  fi
else arm64_reason='--no-arm64'; fi
[ -z "$arm64_reason" ] || echo "arm64 skipped: $arm64_reason" >&2

# 2. sources
step "sources: $ref = $commit"
if [ "$ref" = HEAD ]; then git -C "$ROOT" bundle create "$work/in/src.bundle" HEAD 2>/dev/null
else git -C "$ROOT" bundle create "$work/in/src.bundle" "$ref" 2>/dev/null; fi
echo "$commit" > "$work/in/REF"
if [ "$overlay" = yes ]; then
  paths=(scripts/release scripts/release-docker scripts/verify platform/infra/build platform/workstation/bootstrap platform/workstation/templates)
  ( cd "$ROOT" && git ls-files -m -o --exclude-standard -- "${paths[@]}" > "$work/in/overlay.list"
    if [ -s "$work/in/overlay.list" ]; then tar -cf "$work/in/overlay.tar" -T "$work/in/overlay.list"; fi )
  echo "overlay: $(wc -l < "$work/in/overlay.list") uncommitted files"
fi
cp "$HERE/in-container.sh" "$work/tools/in-container.sh"

# 3.–5. containers
name="atl-release-amd64-$$"
cleanup() { if [ "$keep" = no ]; then dk rm -f "$name" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
mounts_amd64=(--mount "type=bind,source=$WORK_H,target=/xfer" --mount "type=bind,source=$OUT_H,target=/out" --mount "type=bind,source=$CACHE_H/npm-amd64,target=/root/.npm")
mounts_arm64=(--mount "type=bind,source=$WORK_H,target=/xfer" --mount "type=bind,source=$OUT_H,target=/out" --mount "type=bind,source=$CACHE_H/npm-arm64,target=/root/.npm")
envs=(-e "SOURCE_DATE_EPOCH=$epoch" -e "REL_VERSION=$version" -e "SSM_AGENT_MIN_VERSION=${SSM_AGENT_MIN_VERSION:-}")
dk run -d --name "$name" --platform linux/amd64 "${mounts_amd64[@]}" "${envs[@]}" atl-release-builder:amd64 sleep infinity >/dev/null
run_amd64() { dk exec "${envs[@]}" "$name" bash /xfer/tools/in-container.sh "$@"; }
run_arm64() { dk run --rm --platform linux/arm64 "${mounts_arm64[@]}" "${envs[@]}" atl-release-builder:arm64 bash /xfer/tools/in-container.sh "$@"; }

step "amd64: npm ci, builds, x86_64 archive (logs/build-amd64.log)"
run_amd64 build > "$work/logs/build-amd64.log" 2>&1 || { tail -40 "$work/logs/build-amd64.log" >&2; exit 1; }
grep -E '^\[|AppArchiveSha256|native modules load' "$work/logs/build-amd64.log" || true
cver=$(cat "$work/VERSION")
arm64_status=skipped
if [ "$arm64" = yes ]; then
  step "arm64 (QEMU): arm64 archive (logs/arch-arm64.log)"
  if run_arm64 arch arm64 > "$work/logs/arch-arm64.log" 2>&1; then
    grep -E '^\[|AppArchiveSha256|native modules load' "$work/logs/arch-arm64.log" || true
    step "arm64 (QEMU): node_modules for the workstation and the runner (logs/ws-modules-arm64.log)"
    if run_arm64 ws-modules > "$work/logs/ws-modules-arm64.log" 2>&1; then arm64_status=built
    else arm64_status=failed; arm64_reason="ws-modules failed: $(tail -3 "$work/logs/ws-modules-arm64.log" | tr '\n' ' ')"; fi
    grep -E '^\[|ws-modules:' "$work/logs/ws-modules-arm64.log" || true
  else
    arm64_status=failed; arm64_reason="scripts/release for arm64 failed: $(tail -3 "$work/logs/arch-arm64.log" | tr '\n' ' ')"
  fi
  [ "$arm64_status" = built ] || echo "arm64: $arm64_reason" >&2
fi

step "amd64: platform:package + preflight (logs/package.log)"
run_amd64 package "${extra[@]}" > "$work/logs/package.log" 2>&1 || { tail -40 "$work/logs/package.log" >&2; exit 1; }
sed -n '/^release →/,$p' "$work/logs/package.log"
tag=$(git -C "$ROOT" show "$commit:platform/VERSION" | tr -d '\r\n'); tag="v$tag"

node -e '
  const fs = require("node:fs"), path = require("node:path");
  const [out, work, commit, epoch, cver, tag, started, secs, arm64, reason, base] = process.argv.slice(1);
  const pre = fs.existsSync(path.join(work, "preflight-artifacts.json")) ? JSON.parse(fs.readFileSync(path.join(work, "preflight-artifacts.json"), "utf8")) : null;
  const app = fs.existsSync(path.join(out, "app")) ? fs.readdirSync(path.join(out, "app")).filter((f) => f.startsWith(`cloudalbum-${cver}-`) && f.endsWith(".tgz")) : [];
  const report = { schema: "atl.release-build/v1", commit, sourceDateEpoch: Number(epoch), cloudalbumVersion: cver, platformTag: tag, startedAt: started,
    durationSeconds: Number(secs), builder: "amazonlinux:2023 + nodejs22 (scripts/release-docker/Dockerfile.builder)", baseImage: base || null,
    appArchives: app.map((f) => ({ file: `app/${f}`, sha256: fs.readFileSync(path.join(out, "app", `${f}.sha256`), "utf8").split(/\s/)[0] })),
    arm64: { status: arm64, ...(reason ? { reason } : {}) }, release: tag,
    preflight: pre ? { failures: pre.failures, warnings: pre.results.filter((r) => r.status === "warn").map((r) => `${r.id}: ${r.detail}`) } : null };
  fs.writeFileSync(path.join(out, "build-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
' "$out" "$work" "$commit" "$epoch" "$cver" "$tag" "$started" "$(( $(date +%s) - t0 ))" "$arm64_status" "$arm64_reason" "$base_digest"
step "done: $out"
