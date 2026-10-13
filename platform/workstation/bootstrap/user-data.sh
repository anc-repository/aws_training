#!/bin/bash
# platform/workstation/bootstrap/user-data.sh — workstation User Data (03 §4.5). This file is a CloudFormation Fn::Sub
# template embedded into templates/atl-workstation.yaml by platform/infra/build/workstation-template.ts: the only Fn::Sub
# references are the stack values Region, BundleUri and BundleSha256 (dollar-brace form); shell variables are written $NAME.
# It only verifies the bootstrap bundle (whole-file SHA-256 from the stack parameter, then every file against manifest.json)
# and hands over to the bundle's atl-ws-install.sh (bootstrap/install.sh): the installation itself travels with the release.
# Session-independent installation only; the session wiring is ATL-WorkstationSetup (03 §4.6).
set -euo pipefail
exec > >(tee -a /var/log/atl-workstation-bootstrap.log) 2>&1
install -d -m 0755 /etc/atl /var/lib/atl /opt/atl /opt/atl/bin
echo workstation > /etc/atl/host-role
hostnamectl set-hostname atl-ws || true

dnf -y install git jq tmux tar gzip openssh-clients nmap-ncat bind-utils nodejs22 nodejs22-npm
alternatives --set node /usr/bin/node-22 || true

W=$(mktemp -d)
for i in 1 2 3 4 5; do aws s3 cp --only-show-errors --region "${Region}" "${BundleUri}" "$W/atl-workstation.tar.gz" && break; sleep $((i * 5)); done
echo "${BundleSha256}  $W/atl-workstation.tar.gz" | sha256sum -c -
tar -xzf "$W/atl-workstation.tar.gz" -C "$W"
( cd "$W" && jq -r '.files[] | "\(.sha256)  \(.name)"' manifest.json | sha256sum -c --quiet - )
bash "$W/atl-ws-install.sh" "$W"
rm -rf "$W"
echo "ATL workstation bootstrap finished"
