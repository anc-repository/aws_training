#!/usr/bin/env bash
# scripts/release-docker/drill.sh — L0 offline install drill: run the L0 User Data (infra/modules/ec2.yaml, InstanceA) with a
# real release archive in an amazonlinux:2023 container that has no network at all, and check what it built.
#
#   bash scripts/release-docker/drill.sh [--archive <cloudalbum-<ver>-<arch>.tgz>] [--arch x86_64|arm64] [--out <dir>]
#        [--cache <dir>] [--platform-mode off|on] [--refresh-repo] [--keep]
#
# Defaults: the newest dist/release/app/cloudalbum-*-<arch>.tgz, --arch x86_64 (arm64 runs through QEMU and is slow),
# <out> = dist/release/drill/<arch>, <cache> = dist/release-cache. Steps:
#   1. image atl-l0-drill:<arch> (drill/Dockerfile: systemd as PID 1, recorders for cfn-signal and the AWS CLI)
#   2. offline package repository: the packages the archive's l0-bootstrap.sh installs (dnf --downloadonly, signed AL2023
#      RPMs, createrepo_c) — the only online step, cached in <cache>/drill-repo-<arch>; it never runs during the drill
#   3. the User Data stub rendered from the archive's own infra/modules/ec2.yaml (drill/render-user-data.mjs) with the
#      archive's SHA-256 and an http://127.0.0.1 AppArchiveUrl
#   4. container: --privileged (systemd, loop device, nft), --network none; drill/run-drill.sh plays the instance (mock IMDSv2,
#      XFS data volume on a loop device as /dev/sdf, local archive server), runs the User Data, checks, re-runs the bootstrap
# Result: <out>/report.json (+ user-data.log, rerun.log, imds-requests.jsonl, journal.log). Exit 1 when a check failed.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
archive=''; arch=x86_64; out=''; cache="$ROOT/dist/release-cache"; pmode=off; refresh=no; keep=no
while [ $# -gt 0 ]; do
  case "$1" in
    --archive) archive=$2; shift 2 ;;
    --arch) arch=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --cache) cache=$2; shift 2 ;;
    --platform-mode) pmode=$2; shift 2 ;;
    --refresh-repo) refresh=yes; shift ;;
    --keep) keep=yes; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done
case "$arch" in x86_64) plat=linux/amd64; tag=amd64 ;; arm64) plat=linux/arm64; tag=arm64 ;; *) echo "--arch x86_64|arm64" >&2; exit 64 ;; esac
case "$pmode" in on|off) ;; *) echo "--platform-mode on|off" >&2; exit 64 ;; esac
if [ -z "$archive" ]; then
  archive=$(ls -t "$ROOT"/dist/release/app/cloudalbum-*-"$arch".tgz 2>/dev/null | head -1 || true)
  [ -n "$archive" ] || { echo "no dist/release/app/cloudalbum-*-$arch.tgz: run scripts/release-docker/build.sh or pass --archive" >&2; exit 1; }
fi
[ -f "$archive" ] || { echo "archive $archive not found" >&2; exit 1; }
out=${out:-$ROOT/dist/release/drill/$arch}
dk() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker "$@"; }
hostpath() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
step() { printf '\n== %s  %s\n' "$(date +%H:%M:%S)" "$*"; }
rm -rf "$out"; mkdir -p "$out" "$cache/drill-repo-$arch"
in="$out/.in"; rel="$out/.release"; mkdir -p "$in" "$rel"
cp "$archive" "$rel/"
name=$(basename "$archive")
sha=$(sha256sum "$archive" | cut -c1-64)
version_dir=$( (tar -tzf "$archive" 2>/dev/null || true) | head -1 | cut -d/ -f1)

# a native sidecar (drill/Dockerfile.helper, the Docker host's architecture) joins the drill container to install the IMDS
# address and redirect; under QEMU user-mode emulation (arm64 on x86_64: no netfilter netlink, no block-device / XFS ioctls)
# it also formats the data volume
case "$(dk info --format '{{.Architecture}}' 2>/dev/null)" in
  x86_64|amd64) ntag=amd64; nplat=linux/amd64 ;; aarch64|arm64) ntag=arm64; nplat=linux/arm64 ;; *) ntag=$tag; nplat=$plat ;;
esac
emulated=0; [ "$ntag" = "$tag" ] || emulated=1
step "drill images atl-l0-drill:$tag, atl-l0-drill-helper:$ntag"
dk build --platform "$plat" -t "atl-l0-drill:$tag" "$(hostpath "$HERE/drill")" > "$out/image.log" 2>&1 || { tail -20 "$out/image.log" >&2; exit 1; }
dk build --platform "$nplat" -f "$(hostpath "$HERE/drill")/Dockerfile.helper" -t "atl-l0-drill-helper:$ntag" "$(hostpath "$HERE/drill")" >> "$out/image.log" 2>&1   || { tail -20 "$out/image.log" >&2; exit 1; }
helper() { dk run --rm --privileged --network "container:$cname" --platform "$nplat" "atl-l0-drill-helper:$ntag" bash -c "$1"; }

# the package list comes from the archive's own l0-bootstrap.sh (every `dnf -y install` line)
tar -xzf "$archive" -O "$version_dir/infra/userdata/l0-bootstrap.sh" > "$in/l0-bootstrap.sh"
tar -xzf "$archive" -O "$version_dir/infra/modules/ec2.yaml" > "$in/ec2.yaml"
pkgs=$(grep -oE 'dnf -y install [a-z0-9 ._+-]+' "$in/l0-bootstrap.sh" | sed 's/^dnf -y install //' | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')
if [ "$refresh" = yes ] || [ ! -f "$cache/drill-repo-$arch/repodata/repomd.xml" ] || [ "$(cat "$cache/drill-repo-$arch/.packages" 2>/dev/null)" != "$pkgs" ]; then
  step "offline package repository (online, cached): $pkgs"
  rm -rf "${cache:?}/drill-repo-$arch"; mkdir -p "$cache/drill-repo-$arch"
  dk run --rm --platform "$plat" --mount "type=bind,source=$(hostpath "$cache/drill-repo-$arch"),target=/repo" "atl-l0-drill:$tag" bash -c "
    set -e
    dnf -q -y install --downloadonly --setopt=strict=0 --downloaddir=/repo $pkgs >/dev/null 2>&1 || true
    for p in $pkgs; do ls /repo/\$p-[0-9]*.rpm >/dev/null 2>&1 || rpm -q \$p >/dev/null 2>&1 || echo \"not in the AL2023 repositories: \$p\"; done
    createrepo_c -q /repo && ls /repo/*.rpm | wc -l" > "$out/repo.log" 2>&1 || { cat "$out/repo.log" >&2; exit 1; }
  printf '%s' "$pkgs" > "$cache/drill-repo-$arch/.packages"
  cat "$out/repo.log"
else
  echo "offline repository cached: $(ls "$cache/drill-repo-$arch"/*.rpm | wc -l) rpms"
fi

step "render the User Data (InstanceA) from the archive's infra/modules/ec2.yaml"
region=ap-northeast-1; stack=cloudalbum-drill-ec2
node "$HERE/drill/render-user-data.mjs" "$in/ec2.yaml" "$in/user-data.sh" Env=drill "AWS::Region=$region" \
  "AppArchiveUrl=http://127.0.0.1:8080/$name" "AppArchiveSha256=$sha" Eip=203.0.113.10 AdminEmail=admin@example.com \
  "PlatformMode=$pmode" "AWS::StackName=$stack"
mac=02:00:5e:00:53:01
cat > "$in/imds-values.json" <<EOF
{
  "meta-data/instance-id": "i-0d1a11000000000a1",
  "meta-data/instance-type": "$([ "$arch" = arm64 ] && echo t4g.small || echo t3.small)",
  "meta-data/placement/region": "$region",
  "meta-data/placement/availability-zone": "${region}a",
  "meta-data/services/partition": "aws",
  "meta-data/services/domain": "amazonaws.com",
  "meta-data/local-ipv4": "172.31.32.10",
  "meta-data/public-ipv4": "203.0.113.10",
  "meta-data/mac": "$mac",
  "meta-data/network/interfaces/macs/$mac/vpc-ipv4-cidr-blocks": "172.31.0.0/16",
  "meta-data/tags/instance": "Name\nCloudAlbumDataVolume\nCloudAlbumLogicalId",
  "meta-data/tags/instance/Name": "cloudalbum-drill-l0",
  "meta-data/tags/instance/CloudAlbumDataVolume": "attach",
  "meta-data/tags/instance/CloudAlbumLogicalId": "InstanceA",
  "dynamic/instance-identity/document": "{\"accountId\":\"111122223333\",\"region\":\"$region\",\"instanceId\":\"i-0d1a11000000000a1\",\"architecture\":\"$([ "$arch" = arm64 ] && echo arm64 || echo x86_64)\"}"
}
EOF
printf 'ARCHIVE=%s\nARCHIVE_SHA256=%s\nPLATFORM_MODE=%s\nREGION=%s\nCFN_STACK=%s\nEMULATED=%s\n' "$name" "$sha" "$pmode" "$region" "$stack" "$emulated" > "$in/drill.env"

step "drill container (--network none, systemd as PID 1)"
cname="atl-l0-drill-$$"
cleanup() {   # the loop device belongs to the Docker VM's kernel: always detach it (also when the container is already gone)
  [ "$keep" = no ] || { echo "kept container $cname (detach $(cat "$out/loopdev" 2>/dev/null) when done)"; return; }
  dk exec "$cname" bash -c 'systemctl stop cloudalbum-api cloudalbum-worker nginx 2>/dev/null; umount -l /var/lib/cloudalbum 2>/dev/null
    l=$(cat /drill/out/loopdev 2>/dev/null); [ -z "$l" ] || losetup -d "$l"' >/dev/null 2>&1 || true
  dk rm -f "$cname" >/dev/null 2>&1 || true
  l=$(cat "$out/loopdev" 2>/dev/null || true)
  if [ -n "$l" ]; then
    dk run --rm --privileged --platform "$nplat" "atl-l0-drill-helper:$ntag" bash -c "[ \"\$(cat /sys/block/${l#/dev/}/loop/backing_file 2>/dev/null)\" = /var/tmp/drill-data.img ] && losetup -d $l; true" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
dk run -d --name "$cname" --platform "$plat" --privileged --network none --hostname ip-172-31-32-10 \
  --tmpfs /run --tmpfs /run/lock \
  --mount "type=bind,source=$(hostpath "$HERE/drill"),target=/drill/bin,readonly" \
  --mount "type=bind,source=$(hostpath "$cache/drill-repo-$arch"),target=/drill/repo,readonly" \
  --mount "type=bind,source=$(hostpath "$rel"),target=/drill/release,readonly" \
  --mount "type=bind,source=$(hostpath "$in"),target=/drill/in,readonly" \
  --mount "type=bind,source=$(hostpath "$out"),target=/drill/out" \
  "atl-l0-drill:$tag" >/dev/null
for _ in $(seq 1 60); do
  s=$(dk exec "$cname" systemctl is-system-running 2>/dev/null || true)
  case "$s" in running|degraded) break ;; esac; sleep 1
done
echo "systemd: $s"
# IMDS address and redirect (169.254.169.254:80 → the mock on 127.0.0.1:8169), set up natively in the drill's namespace
helper 'ip addr add 169.254.169.254/32 dev lo 2>/dev/null || true
  nft list table ip drill >/dev/null 2>&1 || { nft add table ip drill && nft "add chain ip drill out { type nat hook output priority -100; }"     && nft add rule ip drill out ip daddr 169.254.169.254 tcp dport 80 dnat to 127.0.0.1:8169; }' || { echo "IMDS redirect setup failed" >&2; exit 1; }
rc=0
dk exec "$cname" bash /drill/bin/run-drill.sh prepare || rc=$?
if [ "$rc" = 0 ] && [ "$emulated" = 1 ]; then
  l=$(cat "$out/loopdev"); helper "mkfs.xfs -q -L cadata $l" || { echo "native mkfs.xfs of $l failed" >&2; rc=1; }
fi
[ "$rc" = 0 ] && { dk exec "$cname" bash /drill/bin/run-drill.sh run || rc=$?; }
rm -rf "$in" "$rel"
step "report: $out/report.json (exit $rc)"
exit "$rc"
