#!/bin/bash
# scripts/release-docker/drill/run-drill.sh [prepare|run|all] — inside the drill container (systemd is PID 1, --network none,
# privileged): play the EC2 instance for the L0 User Data and check the result. Started by scripts/release-docker/drill.sh
# (`prepare`, then its native sidecar, then `run`).
#   /drill/bin      this directory (imds.py)                 /drill/repo     offline AL2023 package repository (createrepo_c)
#   /drill/release  the release archive (served on :8080)     /drill/in       user-data.sh (rendered), imds-values.json, drill.env
#   /drill/out      report.json, logs
# What is real: the rendered User Data stub, l0-bootstrap.sh and everything it runs (dnf from AL2023 packages, Node 22,
# nginx, users, the release, host files, systemd units, the XFS data volume on a loop device, secrets, migrations, services,
# health check). What is simulated: IMDSv2 (mock on 169.254.169.254 via nft DNAT), the archive URL (local HTTP), the
# network (none: the drill cannot reach AWS or anything else), cfn-signal (recorder), swapon (no-op, see the Dockerfile).
set -uo pipefail
PHASE=${1:-all}
OUT=/drill/out
mkdir -p "$OUT"
exec > >(tee -a "$OUT/run-drill.log") 2>&1
# shellcheck source=/dev/null
. /drill/in/drill.env          # ARCHIVE, ARCHIVE_SHA256, PLATFORM_MODE, REGION, CFN_STACK, EMULATED
check() {  # <id> <pass|fail|degraded|info> <detail>
  printf '%s\t%s\t%s\n' "$1" "$2" "$(printf '%s' "$3" | tr '\t\n' '  ')" >> "$OUT/checks.tsv"
  printf '  %-9s %-26s %s\n' "$(printf '%s' "$2" | tr a-z A-Z)" "$1" "$3"
}
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# ---- 0. the "instance" ---------------------------------------------------------------------------------------------
prepare() {
  local ifs loopdev
  : > "$OUT/checks.tsv"
  log "drill on $(uname -m), $(. /etc/os-release; echo "$PRETTY_NAME"), systemd $(systemctl --version | head -1 | awk '{print $2}'), emulated=${EMULATED:-0}"
  ifs=$(ip -o link show | awk -F': ' '{print $2}' | grep -v '^lo$' | tr '\n' ' ')
  if [ -z "$ifs" ]; then check offline pass "no network interface besides lo (docker --network none)"; else check offline fail "interfaces: $ifs"; fi
  # packages: only the offline repository (signed AL2023 packages, gpgcheck on)
  install -d /etc/yum.repos.d.drill-disabled
  mv /etc/yum.repos.d/*.repo /etc/yum.repos.d.drill-disabled/ 2>/dev/null || true
  cat > /etc/yum.repos.d/drill-local.repo <<'EOF'
[drill-local]
name=drill: offline copy of the AL2023 packages l0-bootstrap.sh installs
baseurl=file:///drill/repo
enabled=1
gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-amazon-linux-2023
metadata_expire=never
EOF
  # IMDSv2 mock: 169.254.169.254:80 → 127.0.0.1:8169. drill.sh installs the address and the nft redirect from a native sidecar
  # (QEMU user-mode emulation has no netfilter netlink); done here only when this script runs on its own, natively
  if [ "${EMULATED:-0}" != 1 ] && ! nft list table ip drill >/dev/null 2>&1; then
    ip addr add 169.254.169.254/32 dev lo 2>/dev/null || true
    nft add table ip drill && nft 'add chain ip drill out { type nat hook output priority -100; }' \
      && nft add rule ip drill out ip daddr 169.254.169.254 tcp dport 80 dnat to 127.0.0.1:8169
  fi
  if [ "${EMULATED:-0}" = 1 ]; then
    # QEMU user-mode emulation runs neither chronyd (clock syscalls) nor the XFS / block-device ioctls of mkfs.xfs and
    # xfs_growfs: chronyd gets a stand-in unit, xfs_growfs a no-op (like swapon), and drill.sh formats the volume natively
    install -d /etc/systemd/system/chronyd.service.d
    cat > /etc/systemd/system/chronyd.service.d/zz-drill-qemu.conf <<'EOF'
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=
ExecStart=
ExecStart=/bin/true
ExecStartPost=
EOF
    cat > /usr/local/sbin/xfs_growfs <<'EOF'
#!/bin/bash
echo "$(date -u +%FT%TZ) $*" >> /var/log/drill-xfs_growfs.log
exit 0
EOF
    chmod 0755 /usr/local/sbin/xfs_growfs
    # nginx sizes map_hash_bucket_size by the CPU cache line; under QEMU glibc reports 32 bytes (64 on Graviton and x86_64)
    # and CloudAlbum's $ca_block map no longer fits — see implementation-notes platform-release (infra should pin it)
    install -d /etc/nginx/conf.d
    echo 'map_hash_bucket_size 64;   # drill under QEMU only: the emulated cache line is 32 bytes' > /etc/nginx/conf.d/00-drill-qemu.conf
    systemctl daemon-reload
  fi
  : > "$OUT/imds-requests.jsonl"
  systemd-run --unit drill-imds --quiet python3 /drill/bin/imds.py --port 8169 --values /drill/in/imds-values.json --log "$OUT/imds-requests.jsonl"
  systemd-run --unit drill-archive --quiet python3 -m http.server 8080 --bind 127.0.0.1 --directory /drill/release
  for _ in $(seq 1 100); do
    curl -fsS -m 1 -o /dev/null "http://127.0.0.1:8080/$ARCHIVE" 2>/dev/null \
      && curl -fsS -m 1 -o /dev/null -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null \
      && break
    sleep 0.3
  done
  : > "$OUT/imds-requests.jsonl"   # the readiness probe above is not part of the drill
  # sshd as on the AMI (host keys are generated at first boot there): install-host-files.sh validates its drop-in with sshd -t
  ssh-keygen -A >/dev/null 2>&1 && systemctl start sshd 2>/dev/null || true
  # data volume: a sparse 4 GiB file on a loop device, presented as /dev/sdf (AL2023's udev rules do this for the EBS volume)
  truncate -s 4G /var/tmp/drill-data.img
  loopdev=$(losetup -f --show /var/tmp/drill-data.img)
  echo "$loopdev" > "$OUT/loopdev"
  ln -sf "$loopdev" /dev/sdf
  # udev is not running in a container: create the by-label link it would create once mkfs.xfs labels the volume (the fstab
  # entry LABEL=cadata makes systemd run systemd-fsck@dev-disk-by-label-cadata before units with RequiresMountsFor=)
  install -d /dev/disk/by-label && ln -sf "$loopdev" /dev/disk/by-label/cadata
  log "IMDS mock, archive server and data volume ($loopdev as /dev/sdf) ready"
}
case "$PHASE" in prepare|all) prepare ;; run) ;; *) echo "usage: run-drill.sh [prepare|run|all]" >&2; exit 64 ;; esac
[ "$PHASE" = prepare ] && exit 0
loopdev=$(cat "$OUT/loopdev")
if [ "${EMULATED:-0}" = 1 ]; then
  [ "$(blkid -p -s LABEL -o value "$loopdev" 2>/dev/null)" = cadata ] \
    && check data-format degraded "QEMU: the volume was formatted by the native sidecar (mkfs.xfs ioctls are not emulated); the bootstrap takes its existing-volume path" \
    || check data-format fail "QEMU: the native sidecar did not format $loopdev"
fi

# ---- 1. the User Data stub, as cloud-init runs it ------------------------------------------------------------------
failed_before=$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | sort | tr '\n' ' ')
log "running the rendered User Data (log: user-data.log)"
t0=$(date +%s)
bash /drill/in/user-data.sh > "$OUT/user-data.log" 2>&1
rc=$?
t1=$(date +%s)
echo "$rc" > "$OUT/user-data.rc"
log "User Data exited $rc after $((t1 - t0)) s"

echo; echo "checks:"
if [ "$rc" = 0 ]; then check user-data pass "exit 0 in $((t1 - t0)) s"; else check user-data fail "exit $rc (tail: $(tail -3 "$OUT/user-data.log" | tr '\n' ' '))"; fi
rel=$(readlink -f /opt/cloudalbum 2>/dev/null || true)
if [ -n "$rel" ] && [ -f "$rel/.extract-complete" ]; then check release pass "/opt/cloudalbum → $rel (VERSION $(cat "$rel/VERSION"))"; else check release fail "no extracted release under /opt/cloudalbum"; fi

nv=$(node --version 2>/dev/null || true)
nreal=$(readlink -f "$(command -v node 2>/dev/null || echo /nonexistent)" 2>/dev/null || true)
case "$nv" in v22.*) check node pass "$nv ($nreal; alternatives: $(alternatives --display node 2>/dev/null | sed -n 's/.*link currently points to //p'))" ;; *) check node fail "node --version: ${nv:-missing}" ;; esac
npmv=$(npm --version 2>/dev/null || true); [ -n "$npmv" ] && check npm pass "npm $npmv" || check npm fail "npm missing"
ngv=$(nginx -v 2>&1 | sed -n 's|.*nginx/||p')
if [ -n "$ngv" ] && nginx -t >/dev/null 2>&1; then check nginx pass "nginx $ngv, nginx -t ok"; else check nginx fail "nginx ${ngv:-missing}; nginx -t: $(nginx -t 2>&1 | tail -1)"; fi

for u in nginx cloudalbum-api cloudalbum-worker; do
  s=$(systemctl is-active "$u" 2>/dev/null); e=$(systemctl is-enabled "$u" 2>/dev/null)
  [ "$s" = active ] && [ "$e" = enabled ] && check "unit:$u" pass "active, enabled" || check "unit:$u" fail "is-active=$s is-enabled=$e"
done
for u in cloudalbum-backup.timer cloudalbum-security-snapshot.timer cloudalbum-healthcheck.timer cloudalbum-vuln-scan.timer cloudalbum-denylist.path; do
  s=$(systemctl is-active "$u" 2>/dev/null); e=$(systemctl is-enabled "$u" 2>/dev/null)
  [ "$s" = active ] && [ "$e" = enabled ] && check "unit:$u" pass "active, enabled" || check "unit:$u" fail "is-active=$s is-enabled=$e"
done
s=$(systemctl is-active chronyd 2>/dev/null)
if [ "${EMULATED:-0}" = 1 ]; then check unit:chronyd degraded "is-active=$s through a stand-in unit: QEMU user-mode emulation cannot run chronyd"
elif [ "$s" = active ]; then check unit:chronyd pass "active (no time source is reachable offline)"
else check unit:chronyd fail "is-active=$s"; fi
failed=$(comm -13 <(tr ' ' '\n' <<< "$failed_before" | grep -v '^$' | sort) <(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | sort) | tr '\n' ' ')
[ -z "$failed" ] && check systemd pass "no unit failed since the User Data started ($(systemctl is-system-running 2>/dev/null))${failed_before:+; failed before it: $failed_before}" || check systemd fail "failed units: $failed"

code=$(curl -s -o "$OUT/health.json" -w '%{http_code}' -m 5 'http://127.0.0.1/api/health/ready?scope=instance' || true)
[ "$code" = 200 ] && check health pass "GET /api/health/ready?scope=instance → 200 through nginx" || check health fail "→ ${code:-no answer}"
code=$(curl -sk -o /dev/null -w '%{http_code}' -m 5 https://127.0.0.1/ || true)
case "$code" in 200|301|302) check https pass "GET https://127.0.0.1/ → $code (self-signed certificate)" ;; *) check https fail "→ ${code:-no answer}" ;; esac
code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1/ || true)
case "$code" in 200|301|302|308) check http pass "GET http://127.0.0.1/ → $code" ;; *) check http fail "→ ${code:-no answer}" ;; esac

D=/var/lib/cloudalbum
if mountpoint -q $D && [ "$(findmnt -no FSTYPE $D)" = xfs ] && [ "$(blkid -s LABEL -o value "$loopdev")" = cadata ]; then
  check data-volume pass "$D: xfs LABEL=cadata on $loopdev ($(findmnt -no SIZE $D)), fstab: $(grep -c '^LABEL=cadata ' /etc/fstab) line"
else check data-volume fail "$D mounted=$(mountpoint -q $D && echo yes || echo no) fstype=$(findmnt -no FSTYPE $D 2>/dev/null)"; fi
[ "$(readlink /etc/cloudalbum)" = $D/etc ] && check etc-link pass "/etc/cloudalbum → $D/etc" || check etc-link fail "/etc/cloudalbum → $(readlink /etc/cloudalbum)"
st=$(stat -c '%a %U:%G' $D/etc/secrets.env 2>/dev/null)
[ "$st" = "640 root:cloudalbum" ] && check secrets pass "secrets.env $st, SECRETS_ORIGIN=$(sed -n 's/^SECRETS_ORIGIN=//p' $D/etc/secrets.env)" || check secrets fail "secrets.env: ${st:-missing}"
[ -f $D/etc/keys/jwt-es256.pem ] && check jwt-key pass "ES256 key present ($(stat -c '%a %U:%G' $D/etc/keys/jwt-es256.pem))" || check jwt-key fail "missing"
[ -f $D/db/cloudalbum.sqlite ] && check database pass "SQLite $(stat -c %s $D/db/cloudalbum.sqlite) bytes, owner $(stat -c %U $D/db/cloudalbum.sqlite)" || check database fail "no $D/db/cloudalbum.sqlite"
[ -e $D/etc/.initialized ] && check initialized pass ".initialized written" || check initialized fail ".initialized missing"
fp=$(sed -n 's/^KEY_FINGERPRINT=//p' "$OUT/user-data.log" | tail -1)
[ -n "$fp" ] && check fingerprint pass "KEY_FINGERPRINT=$fp" || check fingerprint fail "no KEY_FINGERPRINT line"
st=$(stat -c '%a' /root/cloudalbum-admin.txt 2>/dev/null)
if [ "${PLATFORM_MODE:-off}" = on ]; then
  # platform mode: the runner creates the application admin (06 PM-07), the bootstrap must not
  [ -z "$st" ] && check admin pass "platform mode: no admin created by the bootstrap (the runner does it, PM-07)" || check admin fail "platform mode but /root/cloudalbum-admin.txt exists"
  ssm=$(cat /opt/cloudalbum/.ssm-agent-check.json 2>/dev/null)
  [ -n "$ssm" ] && check ssm-agent info "platform mode: .ssm-agent-check.json $ssm (amazon-ssm-agent is preinstalled on the AMI, not in the drill image)" || check ssm-agent fail "platform mode: no .ssm-agent-check.json"
else
  [ "$st" = 600 ] && check admin pass "/root/cloudalbum-admin.txt (0600) created by admin:ensure" || check admin fail "admin password file: ${st:-missing}"
fi
id=$(id cloudalbum 2>/dev/null)
case "$id" in *uid=2001*gid=2001*) check users pass "$(echo "$id" | cut -d' ' -f1-2), nginx in group cloudalbum: $(id -nG nginx | grep -qw cloudalbum && echo yes || echo no)" ;; *) check users fail "${id:-no cloudalbum user}" ;; esac
digest=$(node -e 'process.stdout.write(String(require("/opt/cloudalbum/.release-manifest.json").atlBundleDigest || ""))' 2>/dev/null)
if [ -n "$digest" ] && [ "$(sha256sum "/opt/atl/checks/$digest/manifest.json" 2>/dev/null | cut -c1-64)" = "$digest" ] && [ -x /opt/atl/bin/atl-check ]; then
  check atl-checks pass "/opt/atl/checks/$digest, /opt/atl/bin/atl-check"
else check atl-checks fail "check bundle ${digest:-?} not installed"; fi
natives=$(cd /opt/cloudalbum && runuser -u cloudalbum -- node -e '
  const { createRequire } = require("node:module");
  const b = createRequire("/opt/cloudalbum/backend/package.json"), i = createRequire("/opt/cloudalbum/packages/image-core/package.json");
  (async () => {
    const db = new (b("better-sqlite3"))(":memory:"); const v = db.prepare("select sqlite_version() v").get().v; db.close();
    const sharp = i("sharp"); await sharp({ create: { width: 4, height: 4, channels: 3, background: "#123456" } }).webp().toBuffer();
    const a = b("@node-rs/argon2"); await a.verify(await a.hash("drill"), "drill");
    console.log(`better-sqlite3 (sqlite ${v}), sharp ${sharp.versions.sharp ?? ""}/libvips ${sharp.versions.vips}, argon2 on ${process.arch}`);
  })().catch((e) => { console.log("ERROR " + e.message); process.exit(1); });' 2>&1)
[ $? = 0 ] && check native-modules pass "$natives (as user cloudalbum)" || check native-modules fail "$natives"
if [ -f /swapfile ] && [ "$(stat -c %s /swapfile)" = 1073741824 ] && grep -q '^/swapfile ' /etc/fstab && [ "$(blkid -p -s TYPE -o value /swapfile 2>/dev/null)" = swap ]; then
  check swap degraded "/swapfile 1 GiB + mkswap + fstab ok; swapon is a no-op in the container ($(wc -l < /var/log/drill-swapon.log 2>/dev/null || echo 0) call)"
else check swap fail "swap file not prepared"; fi
sig=$(cat /var/log/drill-cfn-signal.log 2>/dev/null || true)
case "$sig" in *"-e 0 --stack $CFN_STACK --region $REGION --resource InstanceA"*) check cfn-signal pass "recorded: $(echo "$sig" | tail -1 | cut -d' ' -f2-)" ;; *) check cfn-signal fail "recorded: ${sig:-nothing}" ;; esac
if [ -s /var/log/drill-aws-cli.log ]; then check no-aws-cli fail "the AWS CLI was invoked: $(head -3 /var/log/drill-aws-cli.log | tr '\n' ';')"; else check no-aws-cli pass "the AWS CLI was never invoked"; fi
paths=$(python3 -c '
import json, collections
c = collections.Counter()
for l in open("/drill/out/imds-requests.jsonl"):
    r = json.loads(l)
    c["%s %s %s" % (r["method"], r["path"], r["status"])] += 1
print("; ".join("%s x%d" % kv for kv in sorted(c.items())))')
if grep -q '"status": 401' "$OUT/imds-requests.jsonl"; then check imds fail "requests without a valid token: $paths"
elif [ -z "$paths" ]; then check imds fail "no IMDS request reached the mock"
else check imds pass "$paths"; fi
if rpm -q fail2ban-server >/dev/null 2>&1; then
  s=$(systemctl is-active fail2ban 2>/dev/null)
  [ "$s" = active ] && check fail2ban pass "fail2ban $(rpm -q --qf '%{VERSION}' fail2ban-server) active ($(ls /etc/fail2ban/jail.d 2>/dev/null | tr '\n' ' '))" || check fail2ban fail "fail2ban installed but is-active=$s"
elif grep -q 'fail2ban unavailable' "$OUT/user-data.log"; then
  check fail2ban info "no fail2ban package: the bootstrap fell back to sshd MaxAuthTries + Nginx limit_req"
fi
if [ -f /etc/ssh/sshd_config.d/40-cloudalbum.conf ] && sshd -t 2>/dev/null; then check sshd pass "40-cloudalbum.conf installed and accepted by sshd -t"; else check sshd fail "sshd hardening drop-in missing or rejected"; fi

# ---- 2. idempotence (invariant: re-running the bootstrap converges, nothing is regenerated) -------------------------
log "second run of l0-bootstrap.sh all (log: rerun.log)"
t0=$(date +%s)
bash /var/tmp/l0-bootstrap.sh all > "$OUT/rerun.log" 2>&1
rc2=$?
fp2=$(sed -n 's/^KEY_FINGERPRINT=//p' "$OUT/rerun.log" | tail -1)
code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 'http://127.0.0.1/api/health/ready?scope=instance' || true)
if [ "$rc2" = 0 ] && [ -n "$fp" ] && [ "$fp2" = "$fp" ] && [ "$code" = 200 ]; then
  check rerun pass "exit 0 in $(( $(date +%s) - t0 )) s, same KEY_FINGERPRINT, health 200"
else check rerun fail "exit $rc2, fingerprint ${fp2:-none} (first ${fp:-none}), health $code"; fi

# ---- report ---------------------------------------------------------------------------------------------------------
python3 - "$OUT" <<'PY'
import json, sys, os, platform
out = sys.argv[1]
checks = []
for line in open(os.path.join(out, 'checks.tsv'), encoding='utf-8'):
    cid, status, detail = (line.rstrip('\n').split('\t') + ['', ''])[:3]
    checks.append({'id': cid, 'status': status, 'detail': detail})
env = dict(l.strip().split('=', 1) for l in open('/drill/in/drill.env') if '=' in l)
report = {
    'schema': 'atl.l0-drill/v1', 'machine': platform.machine(), 'emulated': env.get('EMULATED') == '1',
    'archive': env.get('ARCHIVE'), 'archiveSha256': env.get('ARCHIVE_SHA256'), 'platformMode': env.get('PLATFORM_MODE'),
    'userDataExit': int(open(os.path.join(out, 'user-data.rc')).read().strip() or 1),
    'counts': {s: sum(1 for c in checks if c['status'] == s) for s in ('pass', 'fail', 'degraded', 'info')},
    'checks': checks,
}
json.dump(report, open(os.path.join(out, 'report.json'), 'w'), indent=2)
print(f"\n{report['counts']['pass']} pass, {report['counts']['fail']} fail, {report['counts']['degraded']} degraded, {report['counts']['info']} info")
PY
cp /var/log/cloudalbum-bootstrap.log "$OUT/cloudalbum-bootstrap.log" 2>/dev/null || true
journalctl -u cloudalbum-api -u cloudalbum-worker -u nginx --no-pager -n 200 > "$OUT/journal.log" 2>/dev/null || true
grep -q $'\tfail\t' "$OUT/checks.tsv" && exit 1 || exit 0
