#!/usr/bin/env bash
# scripts/release-docker/ws-drill.sh — workstation bootstrap drill: the workstation User Data (platform/workstation/bootstrap/
# user-data.sh, rendered with BundleUri / BundleSha256 from a packaged release) in an amazonlinux:2023 container with no
# network, `aws s3 cp` answered from the release directory (drill/stubs/aws-s3-mock), then atl-ws-install.sh's
# session-manager-plugin path with a wrong and a matching pin against a local server.
#
#   bash scripts/release-docker/ws-drill.sh [--release-dir <dist/release/v…>] [--arch x86_64|arm64] [--out <dir>] [--cache <dir>]
#
# x86_64 (default) checks the installer and the npm fallback decision (the prebuilt node_modules are arm64); arm64 (QEMU,
# slow) also starts scripts/module and `npm run exp` from the prebuilt node_modules. Result: <out>/report.json.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
reldir=''; arch=x86_64; out=''; cache="$ROOT/dist/release-cache"
while [ $# -gt 0 ]; do
  case "$1" in
    --release-dir) reldir=$2; shift 2 ;;
    --arch) arch=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --cache) cache=$2; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done
case "$arch" in x86_64) plat=linux/amd64; tag=amd64 ;; arm64) plat=linux/arm64; tag=arm64 ;; *) echo "--arch x86_64|arm64" >&2; exit 64 ;; esac
if [ -z "$reldir" ]; then reldir=$(ls -td "$ROOT"/dist/release/v*/ 2>/dev/null | head -1 || true); reldir=${reldir%/}; fi
[ -f "$reldir/atl-workstation.tar.gz" ] && [ -f "$reldir/SHA256SUMS" ] || { echo "no packaged release with atl-workstation.tar.gz (--release-dir)" >&2; exit 1; }
out=${out:-$ROOT/dist/release/drill/workstation-$arch}
dk() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker "$@"; }
hostpath() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
step() { printf '\n== %s  %s\n' "$(date +%H:%M:%S)" "$*"; }
rm -rf "$out"; mkdir -p "$out/.in" "$out/.release" "$out/.fake" "$cache/ws-drill-repo-$arch"
cp "$reldir/atl-workstation.tar.gz" "$out/.release/"
sha=$(sed -n 's/^\([0-9a-f]\{64\}\)  atl-workstation\.tar\.gz$/\1/p' "$reldir/SHA256SUMS")
[ -n "$sha" ] || { echo "atl-workstation.tar.gz is not in $reldir/SHA256SUMS" >&2; exit 1; }
tagdir=$(basename "$reldir")

step "drill image atl-l0-drill:$tag"
dk build --platform "$plat" -t "atl-l0-drill:$tag" "$(hostpath "$HERE/drill")" > "$out/image.log" 2>&1 || { tail -20 "$out/image.log" >&2; exit 1; }
ud="$ROOT/platform/workstation/bootstrap/user-data.sh"
pkgs=$(grep -oE '^dnf -y install [a-z0-9 ._+-]+' "$ud" | sed 's/^dnf -y install //' | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')
if [ ! -f "$cache/ws-drill-repo-$arch/repodata/repomd.xml" ] || [ "$(cat "$cache/ws-drill-repo-$arch/.packages" 2>/dev/null)" != "$pkgs" ]; then
  step "offline package repository (online, cached): $pkgs + tree (stands in for the plugin rpm)"
  rm -rf "${cache:?}/ws-drill-repo-$arch"; mkdir -p "$cache/ws-drill-repo-$arch/fake"
  dk run --rm --platform "$plat" --mount "type=bind,source=$(hostpath "$cache/ws-drill-repo-$arch"),target=/repo" "atl-l0-drill:$tag" bash -c "
    set -e
    dnf -q -y install --downloadonly --setopt=strict=0 --downloaddir=/repo $pkgs >/dev/null 2>&1 || true
    for p in $pkgs; do ls /repo/\$p-[0-9]*.rpm >/dev/null 2>&1 || rpm -q \$p >/dev/null 2>&1 || echo \"not available: \$p\"; done
    dnf -q -y install --downloadonly --downloaddir=/repo/fake tree >/dev/null && mv /repo/fake/tree-*.rpm /repo/fake/fake.rpm
    createrepo_c -q --excludes 'fake/*' /repo && ls /repo/*.rpm | wc -l" > "$out/repo.log" 2>&1 || { cat "$out/repo.log" >&2; exit 1; }
  printf '%s' "$pkgs" > "$cache/ws-drill-repo-$arch/.packages"
fi
cp "$cache/ws-drill-repo-$arch/fake/fake.rpm" "$out/.fake/"
node -e '
  const fs = require("node:fs");
  const [src, dst, sha, tag] = process.argv.slice(1);
  const values = { Region: "ap-northeast-1", BundleUri: `s3://atl-artifacts-111122223333-ap-northeast-1/releases/${tag}/atl-workstation.tar.gz`, BundleSha256: sha };
  const out = fs.readFileSync(src, "utf8").replace(/\$\{([^}!]+)\}/g, (m, k) => { if (!(k in values)) throw new Error("no value for " + k); return values[k]; });
  fs.writeFileSync(dst, out);
' "$ud" "$out/.in/user-data.sh" "$sha" "$tagdir"

step "workstation drill container (--network none)"
cname="atl-ws-drill-$$"
trap 'dk rm -f "$cname" >/dev/null 2>&1 || true' EXIT
dk run -d --name "$cname" --platform "$plat" --network none --hostname atl-ws \
  --mount "type=bind,source=$(hostpath "$HERE/drill"),target=/drill/bin,readonly" \
  --mount "type=bind,source=$(hostpath "$HERE/drill/stubs")/aws-s3-mock,target=/usr/local/bin/aws,readonly" \
  --mount "type=bind,source=$(hostpath "$cache/ws-drill-repo-$arch"),target=/drill/repo,readonly" \
  --mount "type=bind,source=$(hostpath "$out/.release"),target=/drill/release,readonly" \
  --mount "type=bind,source=$(hostpath "$out/.fake"),target=/drill/fake,readonly" \
  --mount "type=bind,source=$(hostpath "$out/.in"),target=/drill/in,readonly" \
  --mount "type=bind,source=$(hostpath "$out"),target=/drill/out" \
  "atl-l0-drill:$tag" sleep infinity >/dev/null
rc=0
dk exec "$cname" bash /drill/bin/run-ws-drill.sh || rc=$?
rm -rf "$out/.in" "$out/.release" "$out/.fake"
step "report: $out/report.json (exit $rc)"
exit "$rc"
