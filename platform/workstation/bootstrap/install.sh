#!/bin/bash
# atl-ws-install.sh <bundle dir> — the workstation installation (03 §4.5), shipped in atl-workstation.tar.gz as
# atl-ws-install.sh and run by the user data (bootstrap/user-data.sh) as root, after the bundle passed both integrity checks
# (BundleSha256 of the whole tarball, then every file against manifest.json). Session-independent; idempotent.
#   1. session-manager-plugin: a bundled rpm when present; otherwise downloaded from the official AWS URL in the manifest
#      (tools.sessionManagerPlugin.urls[<machine>]) and installed only when it matches the pinned SHA-256 — an unpinned or
#      mismatching download is never installed (the workstation still works; `aws ssm start-session` does not)
#   2. k6: optional (the experiments runner is Node and does not need it); installed only when the bundle carries it
#   3. ATL tools, profile.d, check bundle (/opt/atl/checks/<digest>/, /opt/atl/bin/atl-check; 04 §6.2)
#   4. labuser (idempotent with ATL-PrepareInstance)
#   5. the repository at the platform's version, with node_modules: prebuilt (cloudalbum-node_modules.tar.gz, matching
#      machine) or installed from the npm registry now (atl-install-node-modules.sh) — the latter needs internet access
#   6. /var/lib/atl/installed.json (ATL-WorkstationSetup waits for it) with the outcome of every optional part
# Test hook (never set on a real workstation): ATL_WS_DNF_ARGS adds dnf options. Drill: scripts/release-docker/ws-drill.sh.
set -euo pipefail
W=${1:?usage: atl-ws-install.sh <bundle dir>}
M="$W/manifest.json"
MACHINE=$(uname -m)
log() { echo "atl-ws-install: $*"; }
jqm() { jq -r "$@" "$M"; }
# shellcheck disable=SC2086
dnf_install() { dnf -y ${ATL_WS_DNF_ARGS:-} install "$@"; }
install -d -m 0755 /etc/atl /var/lib/atl /opt/atl /opt/atl/bin

# ---- 1. session-manager-plugin ----------------------------------------------------------------------------------
ssm_status=skipped; ssm_source=none; ssm_version=''; ssm_reason=''
ssm_plugin() {
  local url sha tmp f proto
  if [ -f "$W/session-manager-plugin.rpm" ]; then
    ssm_source=bundle
    dnf_install "$W/session-manager-plugin.rpm" && ssm_status=installed || { ssm_status=failed; ssm_reason='dnf install of the bundled rpm failed'; }
    return 0
  fi
  [ "$(jqm '.tools.sessionManagerPlugin.source // "none"')" = download ] || { ssm_reason='the bundle has no session-manager-plugin source'; return 0; }
  ssm_source=download
  ssm_version=$(jqm '.tools.sessionManagerPlugin.version // ""')
  url=$(jqm --arg m "$MACHINE" '.tools.sessionManagerPlugin.urls[$m] // ""')
  sha=$(jqm --arg m "$MACHINE" '.tools.sessionManagerPlugin.sha256[$m] // ""')
  [ -n "$url" ] || { ssm_reason="no download URL for $MACHINE"; return 0; }
  [[ $sha =~ ^[0-9a-f]{64}$ ]] || { ssm_reason="SHA-256 of session-manager-plugin $ssm_version for $MACHINE is not pinned: not installing an unverified binary"; return 0; }
  proto='=https'; case "$url" in http://127.0.0.1:*|http://localhost:*) proto='=http,https' ;; esac   # local test servers only
  tmp=$(mktemp -d); f="$tmp/session-manager-plugin.rpm"
  for i in 1 2 3 4 5; do
    curl -fsSL --proto "$proto" --retry 2 --connect-timeout 10 --max-time 300 -o "$f" "$url" && break
    rm -f "$f"; sleep $((i * 3))
  done
  if [ ! -s "$f" ]; then ssm_status=failed; ssm_reason="download failed: $url"
  elif ! echo "$sha  $f" | sha256sum -c --quiet - >/dev/null 2>&1; then
    ssm_status=failed; ssm_reason="download does not match the pinned SHA-256 (got $(sha256sum "$f" | cut -c1-64)): not installed"
  elif dnf_install "$f"; then ssm_status=installed; ssm_version=$(session-manager-plugin --version 2>/dev/null || echo "$ssm_version")
  else ssm_status=failed; ssm_reason='dnf install of the verified rpm failed'
  fi
  rm -rf "$tmp"
}
ssm_plugin
log "session-manager-plugin: $ssm_status ($ssm_source${ssm_version:+ $ssm_version})${ssm_reason:+ — $ssm_reason}"

# ---- 2. k6 (optional) ---------------------------------------------------------------------------------------------
k6_status=absent
k6_file=$(jqm '.tools.k6.file // ""')
if [ -n "$k6_file" ] && [ -f "$W/$k6_file" ]; then
  if tar -xzf "$W/$k6_file" -C /usr/local/bin --strip-components=1 --wildcards '*/k6'; then k6_status=installed; else k6_status=failed; fi
fi
log "k6: $k6_status (optional; npm run exp uses the Node load generator)"

# ---- 3. ATL tools, profile, check bundle --------------------------------------------------------------------------
install -m 0755 "$W/atl-credentials" "$W/atl-workstation-setup.sh" "$W/atl-agent-call" "$W/atl-lab-proxy" "$W/atl-write-session-files" /opt/atl/bin/
install -m 0644 "$W/profile.d-atl.sh" /etc/profile.d/atl.sh
# check bundle: checks/<bundleDigest>/ and bin/atl-check, same layout as on the lab instance (04 §6.2)
if [ -f "$W/atl-checks.tar.gz" ]; then install -d -m 0755 /opt/atl/checks && tar -xzf "$W/atl-checks.tar.gz" -C /opt/atl; else log "warning: no check bundle in the bundle"; fi

# ---- 4. labuser, idempotent with ATL-PrepareInstance (State Manager may run first) ---------------------------------
getent group labuser >/dev/null || groupadd -g 2100 labuser
id labuser >/dev/null 2>&1 || useradd -u 2100 -g 2100 -m -s /bin/bash labuser
passwd -l labuser >/dev/null 2>&1 || true
install -d -m 0750 /etc/sudoers.d
echo 'labuser ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-atl-labuser && chmod 0440 /etc/sudoers.d/90-atl-labuser

# ---- 5. the repository at the platform's version (scripts/module, experiments/) -----------------------------------
REPO=/home/labuser/cloudalbum
install -d -o labuser -g labuser "$REPO"
tar -xzf "$W/cloudalbum-src.tar.gz" -C "$REPO"
nm_source=$(jqm '.nodeModulesInfo.source // (if .nodeModules then "in-source" else "npm-at-boot" end)')
nm_status=ok
case "$nm_source" in
  prebuilt)
    nm_file="$W/$(jqm '.nodeModulesInfo.file')"
    nm_arch=$(jqm '.nodeModulesInfo.arch // ""')
    case "$nm_arch" in arm64) nm_arch=aarch64 ;; x64|amd64) nm_arch=x86_64 ;; esac
    if [ -n "$nm_arch" ] && [ "$nm_arch" != "$MACHINE" ]; then
      log "prebuilt node_modules are for $nm_arch, this is $MACHINE: installing from the npm registry instead"
      nm_source=npm-at-boot
    else
      rm -rf "$REPO/node_modules"; tar -xzf "$nm_file" -C "$REPO"
    fi ;;
  in-source) ;;
esac
if [ "$nm_source" = npm-at-boot ]; then
  # no prebuilt node_modules for this machine: install them now (needs the npm registry; 03 §4.5 prefers the prebuilt set)
  if HOME=/root bash "$W/atl-install-node-modules.sh" "$REPO"; then nm_status=ok; else nm_status=failed; log "warning: node_modules install failed; scripts/module and npm run exp may not run"; fi
fi
log "node_modules: $nm_source ($nm_status)"
chown -R labuser:labuser "$REPO"

# ---- 6. installed.json (written last: ATL-WorkstationSetup retries until it exists) -------------------------------
jq -n --arg c "$(jqm '.repoCommit // ""')" --arg v "$(jqm '.version // ""')" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg ss "$ssm_status" --arg so "$ssm_source" --arg sv "$ssm_version" --arg sr "$ssm_reason" --arg k6 "$k6_status" \
  --arg nms "$nm_source" --arg nmst "$nm_status" --arg m "$MACHINE" \
  '{installed: true, repoCommit: $c, bundleVersion: $v, installedAt: $at, machine: $m,
    tools: {sessionManagerPlugin: {status: $ss, source: $so, version: (if $sv == "" then null else $sv end), reason: (if $sr == "" then null else $sr end)},
            k6: {status: $k6, optional: true}},
    nodeModules: {source: $nms, status: $nmst}}' > /var/lib/atl/installed.json.tmp
mv -f /var/lib/atl/installed.json.tmp /var/lib/atl/installed.json
log "done"
