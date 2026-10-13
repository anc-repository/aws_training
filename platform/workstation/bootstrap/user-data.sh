#!/bin/bash
# platform/workstation/bootstrap/user-data.sh — workstation User Data (03 §4.5). This file is a CloudFormation Fn::Sub
# template embedded into templates/atl-workstation.yaml by platform/infra/build/workstation-template.ts: the only Fn::Sub
# references are the stack values Region, BundleUri and BundleSha256 (dollar-brace form); shell variables are written $NAME.
# Session-independent installation only; the session wiring is ATL-WorkstationSetup (03 §4.6).
set -euo pipefail
exec > >(tee -a /var/log/atl-workstation-bootstrap.log) 2>&1
install -d -m 0755 /etc/atl /var/lib/atl /opt/atl /opt/atl/bin
echo workstation > /etc/atl/host-role
hostnamectl set-hostname atl-ws || true

dnf -y install git jq tmux tar gzip openssh-clients nmap-ncat bind-utils nodejs22 nodejs22-npm
alternatives --set node /usr/bin/node-22 || true

W=$(mktemp -d)
aws s3 cp --region "${Region}" "${BundleUri}" "$W/atl-workstation.tar.gz"
echo "${BundleSha256}  $W/atl-workstation.tar.gz" | sha256sum -c -
tar -xzf "$W/atl-workstation.tar.gz" -C "$W"
( cd "$W" && jq -r '.files[] | "\(.sha256)  \(.name)"' manifest.json | sha256sum -c - )

if [ -f "$W/session-manager-plugin.rpm" ]; then dnf -y install "$W/session-manager-plugin.rpm"; else echo "warning: no session-manager-plugin in the bundle"; fi
if [ -f "$W/k6-linux-arm64.tar.gz" ]; then tar -xzf "$W/k6-linux-arm64.tar.gz" -C /usr/local/bin --strip-components=1 --wildcards '*/k6'; else echo "warning: no k6 in the bundle"; fi
install -m 0755 "$W/atl-credentials" "$W/atl-workstation-setup.sh" "$W/atl-agent-call" "$W/atl-lab-proxy" "$W/atl-write-session-files" /opt/atl/bin/
install -m 0644 "$W/profile.d-atl.sh" /etc/profile.d/atl.sh
# check bundle: checks/<bundleDigest>/ and bin/atl-check, same layout as on the lab instance (04 §6.2)
if [ -f "$W/atl-checks.tar.gz" ]; then install -d -m 0755 /opt/atl/checks && tar -xzf "$W/atl-checks.tar.gz" -C /opt/atl; else echo "warning: no check bundle in the bundle"; fi

# labuser, idempotent with ATL-PrepareInstance (State Manager may run first)
getent group labuser >/dev/null || groupadd -g 2100 labuser
id labuser >/dev/null 2>&1 || useradd -u 2100 -g 2100 -m -s /bin/bash labuser
passwd -l labuser >/dev/null 2>&1 || true
echo 'labuser ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-atl-labuser && chmod 0440 /etc/sudoers.d/90-atl-labuser

# the repository at the platform's version (scripts/module, experiments/)
install -d -o labuser -g labuser /home/labuser/cloudalbum
tar -xzf "$W/cloudalbum-src.tar.gz" -C /home/labuser/cloudalbum
if [ "$(jq -r '.nodeModules // false' "$W/manifest.json")" != true ]; then
  # source builds ship no prebuilt arm64 node_modules: install them here (needs the npm registry; see implementation notes)
  ( cd /home/labuser/cloudalbum && HOME=/root npm ci --no-audit --no-fund ) || echo "warning: npm ci failed; scripts/module may not run"
fi
chown -R labuser:labuser /home/labuser/cloudalbum
COMMIT=$(jq -r '.repoCommit // ""' "$W/manifest.json")
rm -rf "$W"
jq -n --arg c "$COMMIT" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{installed: true, repoCommit: $c, installedAt: $at}' > /var/lib/atl/installed.json
echo "ATL workstation bootstrap finished"
