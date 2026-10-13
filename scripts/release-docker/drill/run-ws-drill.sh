#!/bin/bash
# scripts/release-docker/drill/run-ws-drill.sh — inside the workstation drill container (--network none): run the rendered
# workstation User Data (platform/workstation/bootstrap/user-data.sh) against the packaged atl-workstation.tar.gz, then
# exercise atl-ws-install.sh's session-manager-plugin download path against a local server. Started by ws-drill.sh.
#   /drill/repo     offline AL2023 packages of the user data's dnf line   /drill/release  atl-workstation.tar.gz (the "bucket")
#   /drill/fake     fake.rpm: stands in for session-manager-plugin.rpm    /drill/in       user-data.sh (rendered)
#   /drill/out      report.json, logs
set -uo pipefail
OUT=/drill/out
mkdir -p "$OUT"
exec > >(tee -a "$OUT/run-ws-drill.log") 2>&1
: > "$OUT/checks.tsv"
check() { printf '%s\t%s\t%s\n' "$1" "$2" "$(printf '%s' "$3" | tr '\t\n' '  ')" >> "$OUT/checks.tsv"; printf '  %-9s %-24s %s\n' "$(printf '%s' "$2" | tr a-z A-Z)" "$1" "$3"; }
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
install -d /etc/yum.repos.d.drill-disabled
mv /etc/yum.repos.d/*.repo /etc/yum.repos.d.drill-disabled/ 2>/dev/null || true
printf '[drill-local]\nname=drill offline packages\nbaseurl=file:///drill/repo\nenabled=1\ngpgcheck=1\ngpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-amazon-linux-2023\nmetadata_expire=never\n' > /etc/yum.repos.d/drill-local.repo
M=$(uname -m)
log "workstation drill on $M"

# ---- 1. the user data (bundle verification + atl-ws-install.sh) -----------------------------------------------------
t0=$(date +%s)
bash /drill/in/user-data.sh > "$OUT/user-data.log" 2>&1
rc=$?
log "user data exited $rc after $(( $(date +%s) - t0 )) s"
echo; echo "checks:"
[ "$rc" = 0 ] && check user-data pass "exit 0 (bundle SHA-256, per-file manifest, atl-ws-install.sh)" || check user-data fail "exit $rc: $(tail -3 "$OUT/user-data.log" | tr '\n' ' ')"
grep -q 'atl-workstation.tar.gz: OK' "$OUT/user-data.log" && check bundle-sha256 pass "BundleSha256 verified" || check bundle-sha256 fail "no 'OK' line for the bundle"
I=/var/lib/atl/installed.json
if [ -f $I ]; then check installed-json pass "$(jq -c '{installed, bundleVersion, machine, tools, nodeModules}' $I)"; else check installed-json fail "missing"; fi
for b in atl-credentials atl-workstation-setup.sh atl-agent-call atl-lab-proxy atl-write-session-files; do [ -x /opt/atl/bin/$b ] || miss="${miss:-} $b"; done
[ -z "${miss:-}" ] && check tools pass "/opt/atl/bin: 5 tools; profile.d: $( [ -f /etc/profile.d/atl.sh ] && echo yes || echo no)" || check tools fail "missing:$miss"
node /opt/atl/bin/atl-agent-call --help >/dev/null 2>&1; [ $? -le 2 ] && check agent-call pass "atl-agent-call starts under node $(node --version)" || check agent-call fail "atl-agent-call does not start"
ls /opt/atl/checks/*/manifest.json >/dev/null 2>&1 && [ -x /opt/atl/bin/atl-check ] && check checks pass "$(ls /opt/atl/checks)" || check checks fail "check bundle not installed"
id labuser >/dev/null 2>&1 && [ -f /home/labuser/cloudalbum/scripts/module ] && check repo pass "labuser + /home/labuser/cloudalbum ($(stat -c %U /home/labuser/cloudalbum))" || check repo fail "labuser or repository missing"
s=$(jq -r '.tools.sessionManagerPlugin.status' $I 2>/dev/null); r=$(jq -r '.tools.sessionManagerPlugin.reason // ""' $I 2>/dev/null)
case "$s" in
  skipped) check ssm-plugin-unpinned pass "not pinned → skipped, nothing installed: $r" ;;
  installed) check ssm-plugin-unpinned info "the bundle carries a pin or an rpm: installed" ;;
  *) check ssm-plugin-unpinned fail "status $s: $r" ;;
esac
[ "$(jq -r '.tools.k6.status' $I 2>/dev/null)" = absent ] && check k6-optional pass "k6 absent, bootstrap finished anyway" || check k6-optional info "k6: $(jq -r '.tools.k6.status' $I 2>/dev/null)"
nm=$(jq -r '.nodeModules.source + " / " + .nodeModules.status' $I 2>/dev/null)
case "$M:$nm" in
  aarch64:"prebuilt / ok") (cd /home/labuser/cloudalbum && runuser -u labuser -- ./scripts/module --help >/dev/null 2>&1 && runuser -u labuser -- npm run -s exp -- --help >/dev/null 2>&1) \
      && check node-modules pass "prebuilt arm64 node_modules: scripts/module and npm run exp start" || check node-modules fail "$nm, but scripts/module or npm run exp does not start" ;;
  x86_64:"npm-at-boot / failed") check node-modules pass "no prebuilt set for x86_64 → npm fallback chosen; it fails here only because the drill has no network (expected)" ;;
  *) check node-modules info "$nm" ;;
esac

# ---- 2. atl-ws-install.sh: pinned download, verified (good digest) and refused (wrong digest) --------------------------
B=$(mktemp -d); tar -xzf /drill/release/atl-workstation.tar.gz -C "$B"
F=/drill/fake/fake.rpm; good=$(sha256sum $F | cut -c1-64); pkg=$(rpm -qp --qf '%{NAME}' $F 2>/dev/null)
nohup python3 -m http.server 8081 --bind 127.0.0.1 --directory /drill/fake >/dev/null 2>&1 &
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8081/fake.rpm 2>/dev/null && break; sleep 0.2; done
pin() {  # <sha256> → manifest with a download spec for this machine pointing at the local server
  jq --arg m "$M" --arg s "$1" '.tools.sessionManagerPlugin = {source: "download", version: "0.0.0-drill",
     urls: {($m): "http://127.0.0.1:8081/fake.rpm"}, sha256: {($m): $s}} | .nodeModulesInfo = {source: "in-source"}' "$B/manifest.json" > "$B/m.tmp" && mv "$B/m.tmp" "$B/manifest.json"
}
pin "$(printf '0%.0s' $(seq 1 64))"
bash "$B/atl-ws-install.sh" "$B" > "$OUT/install-wrong-sha.log" 2>&1
s=$(jq -r '.tools.sessionManagerPlugin.status' $I); r=$(jq -r '.tools.sessionManagerPlugin.reason // ""' $I)
if [ "$s" = failed ] && ! rpm -q "$pkg" >/dev/null 2>&1; then check ssm-plugin-mismatch pass "wrong pin → $s, not installed: $r"; else check ssm-plugin-mismatch fail "status $s, $pkg installed: $(rpm -q "$pkg" 2>&1)"; fi
pin "$good"
bash "$B/atl-ws-install.sh" "$B" > "$OUT/install-good-sha.log" 2>&1
s=$(jq -r '.tools.sessionManagerPlugin.status' $I)
if [ "$s" = installed ] && rpm -q "$pkg" >/dev/null 2>&1; then check ssm-plugin-pinned pass "matching pin → downloaded, verified, dnf-installed ($pkg stands in for the plugin)"; else check ssm-plugin-pinned fail "status $s: $(tail -2 "$OUT/install-good-sha.log" | tr '\n' ' ')"; fi
[ -s /var/log/drill-aws-cli.log ] && check aws-calls info "aws CLI calls (mock S3): $(cut -d' ' -f2- /var/log/drill-aws-cli.log | tr '\n' ';')"

python3 - "$OUT" <<'PY'
import json, sys, os, platform
out = sys.argv[1]
checks = []
for line in open(os.path.join(out, 'checks.tsv'), encoding='utf-8'):
    cid, status, detail = (line.rstrip('\n').split('\t') + ['', ''])[:3]
    checks.append({'id': cid, 'status': status, 'detail': detail})
report = {'schema': 'atl.ws-drill/v1', 'machine': platform.machine(), 'counts': {s: sum(1 for c in checks if c['status'] == s) for s in ('pass', 'fail', 'info')}, 'checks': checks}
json.dump(report, open(os.path.join(out, 'report.json'), 'w'), indent=2)
print(f"\n{report['counts']['pass']} pass, {report['counts']['fail']} fail, {report['counts']['info']} info")
PY
grep -q $'\tfail\t' "$OUT/checks.tsv" && exit 1 || exit 0
