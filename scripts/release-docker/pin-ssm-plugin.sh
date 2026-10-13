#!/usr/bin/env bash
# scripts/release-docker/pin-ssm-plugin.sh [<version>] [--dry-run] — pin the session-manager-plugin download of the workstation
# bundle (03 §4.5; platform/infra/build/workstation-tools.json). Run by the maintainer before packaging a release.
#
# Downloads the RPM of <version> (default: PROTOCOL_COMPAT_VERSION of platform/ssm-client) for both machines from the
# official AWS download location (the versioned form of the URL in the AWS install guide), over HTTPS, and records the
# version, both SHA-256 digests and the date in workstation-tools.json. The workstation later downloads exactly these URLs
# and installs the plugin only when the digest matches; nothing is guessed. When `rpm` is available, the package metadata
# (name, version, architecture) is shown for a visual check. --dry-run prints the URLs and downloads nothing.
# Needs: curl, sha256sum, node. No AWS credentials and no AWS API call (a public HTTPS download).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
CONFIG="$ROOT/platform/infra/build/workstation-tools.json"
version=''; dry=no
for a in "$@"; do case "$a" in --dry-run) dry=yes ;; -h|--help) sed -n '2,12p' "$0"; exit 0 ;; *) version=$a ;; esac; done
if [ -z "$version" ]; then
  version=$(sed -n "s/.*PROTOCOL_COMPAT_VERSION = '\([0-9.]*\)'.*/\1/p" "$ROOT/platform/ssm-client/src/constants.ts" | head -1)
fi
[[ $version =~ ^[0-9]+(\.[0-9]+){1,3}$ ]] || { echo "pin-ssm-plugin: invalid version '$version'" >&2; exit 64; }
url_of() {  # <machine>
  node -e '
    const c = require(process.argv[1]).sessionManagerPlugin;
    process.stdout.write(c.urlTemplate.replace("{version}", process.argv[2]).replace("{platform}", c.platforms[process.argv[3]]));
  ' "$CONFIG" "$version" "$1"
}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
declare -A sums
for m in aarch64 x86_64; do
  u=$(url_of "$m")
  echo "$m: $u"
  [ "$dry" = yes ] && continue
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$tmp/$m.rpm" "$u"
  sums[$m]=$(sha256sum "$tmp/$m.rpm" | cut -c1-64)
  echo "  sha256 ${sums[$m]}  ($(wc -c < "$tmp/$m.rpm") bytes)"
  if command -v rpm >/dev/null 2>&1; then rpm -qp --qf '  rpm: %{NAME} %{VERSION}-%{RELEASE} %{ARCH}\n' "$tmp/$m.rpm" 2>/dev/null || true; fi
done
[ "$dry" = yes ] && exit 0
node -e '
  const fs = require("node:fs");
  const [file, version, a, x] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  c.sessionManagerPlugin.pin = { version, sha256: { aarch64: a, x86_64: x }, pinnedAt: new Date().toISOString().slice(0, 10) };
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
' "$CONFIG" "$version" "${sums[aarch64]}" "${sums[x86_64]}"
echo "pinned session-manager-plugin $version in ${CONFIG#"$ROOT"/} — commit it, then repackage (scripts/release-docker/build.sh)"
