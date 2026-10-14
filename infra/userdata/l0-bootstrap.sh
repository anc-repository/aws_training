#!/bin/bash
# infra/userdata/l0-bootstrap.sh — the only bootstrap script of the ec2 base module (single and asg), idempotent.
# Contract: modular-design.md 2.7 (six invariants) and docs/modules/00-ec2-base.md 6.5.
#   install    : root volume only (packages, user, release, Nginx / systemd / sshd / fail2ban files); never touches the data volume
#   postattach : mount the data volume -> /etc/cloudalbum -> secrets -> replay module host artifacts -> migrate -> start
#                (= /usr/local/sbin/cloudalbum-postattach)
#   all        : install; then postattach when the instance tag CloudAlbumDataVolume=attach (or asg); finally cfn-signal
# Usage: l0-bootstrap.sh all|install|postattach [--regenerate-secrets]
set -euo pipefail
PHASE="${1:-all}"; shift || true
REGEN_SECRETS=no; [ "${1:-}" = --regenerate-secrets ] && REGEN_SECRETS=yes
exec > >(tee -a /var/log/cloudalbum-bootstrap.log) 2>&1
echo "=== $(date -Is) l0-bootstrap phase=$PHASE"

# ---------- 0. parameters and constants (params.env holds parameters only; never an "initialized" marker: invariant 2) ----------
# shellcheck source=/dev/null
. /etc/cloudalbum-bootstrap/params.env
: "${CLOUDALBUM_ENV:?}" "${AWS_REGION:?}" "${APP_ARCHIVE_URL:?}" "${APP_ARCHIVE_SHA256:?}"
: "${DEPLOY_MODE:=single}" "${APP_PUBLIC_IP:=}" "${ADMIN_EMAIL:=}" "${BOOTSTRAP_SIGNAL:=none}" "${CFN_STACK:=}"
: "${PLATFORM_MODE:=off}"
DATA=/var/lib/cloudalbum; ETC=$DATA/etc; LIB=/usr/local/lib/cloudalbum; CA_ID=2001
# marker written when --regenerate-secrets replaced the secrets of an initialized volume; removed only after
# `cli keys:reset-fingerprint` succeeded, so a re-run after a failure in between still finishes the recovery
REGEN_MARKER=$ETC/.secrets-regenerated
ARCHIVE=/var/tmp/cloudalbum-release.tgz

imds() {   # IMDSv2: PUT a token first (hop limit 1 is enough for local processes)
  local t
  t=$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token \
        -H 'X-aws-ec2-metadata-token-ttl-seconds: 300') || return 1
  curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $t" "http://169.254.169.254/latest/meta-data/$1"
}
cli() {
  runuser -u cloudalbum -- env CLOUDALBUM_ENV_DIR=/etc/cloudalbum CLOUDALBUM_ROLE=cli \
    /usr/bin/node /opt/cloudalbum/backend/dist/cli.js "$@"
}
signal() {  # only the `all` phase reports to the CreationPolicy; cfn-signal needs no AWS credentials
  { [ "$PHASE" = all ] && [ "$BOOTSTRAP_SIGNAL" = cfn ]; } || return 0
  /opt/aws/bin/cfn-signal -e "$1" --stack "$CFN_STACK" --region "$AWS_REGION" \
    --resource "$(imds tags/instance/CloudAlbumLogicalId)" || true
}
on_exit() { local rc=$?; if [ "$rc" -ne 0 ]; then signal "$rc"; fi; exit "$rc"; }
trap on_exit EXIT

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }   # $1 >= $2

# PM-06: ATL-RunCheck / ATL-WorkstationSetup use interpolationType ENV_VAR, which needs a minimum SSM Agent version
# (.release-manifest.json ssmAgentMinVersion, filled in after the 07 verification). A failed upgrade never stops the bootstrap;
# platform-status reports meetsMinimum=false and the health gate fails with a repair hint.
ssm_agent_check() {
  local min='' ver ok=null
  if [ -f /opt/cloudalbum/.release-manifest.json ]; then min=$(jq -r '.ssmAgentMinVersion // empty' /opt/cloudalbum/.release-manifest.json || true); fi
  ver=$(rpm -q --qf '%{VERSION}' amazon-ssm-agent 2>/dev/null || true)
  if [ -n "$min" ] && { [ -z "$ver" ] || ! version_ge "$ver" "$min"; }; then
    echo "platform mode: amazon-ssm-agent ${ver:-missing} < $min, upgrading"
    dnf -y upgrade amazon-ssm-agent || dnf -y install amazon-ssm-agent || echo "WARN: amazon-ssm-agent upgrade failed (see the official regional install guide)"
    systemctl restart amazon-ssm-agent || true
    ver=$(rpm -q --qf '%{VERSION}' amazon-ssm-agent 2>/dev/null || true)
  fi
  if [ -z "$ver" ]; then ok=false; elif [ -n "$min" ]; then if version_ge "$ver" "$min"; then ok=true; else ok=false; fi; fi
  printf '{"version":%s,"minimum":%s,"meetsMinimum":%s,"checkedAt":"%s"}\n' \
    "$( [ -n "$ver" ] && printf '"%s"' "$ver" || printf null)" "$( [ -n "$min" ] && printf '"%s"' "$min" || printf null)" \
    "$ok" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /opt/cloudalbum/.ssm-agent-check.json
  echo "platform mode: amazon-ssm-agent ${ver:-missing} (minimum ${min:-unknown}, meetsMinimum=$ok)"
}

install_phase() {
  # 1. packages (D4: Node.js 22 LTS). Skipped when a golden AMI (ami module) already contains them.
  if [ ! -f /opt/cloudalbum/.image-manifest.json ]; then
    dnf -y install nginx nodejs22 nodejs22-npm sqlite tar gzip openssl jq logrotate xfsprogs chrony
    dnf -y install fail2ban-server fail2ban-systemd nftables \
      || echo "WARN: fail2ban unavailable, falling back to sshd MaxAuthTries + Nginx limit_req (shown on /lab)"
  fi
  if [ "$BOOTSTRAP_SIGNAL" = cfn ]; then rpm -q aws-cfn-bootstrap >/dev/null || dnf -y install aws-cfn-bootstrap; fi
  alternatives --set node /usr/bin/node-22           # E4: pin the default node to 22
  # 2. swap (protects the 2 GiB instance during builds / concurrent thumbnails)
  if [ ! -f /swapfile ]; then dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none; chmod 600 /swapfile; mkswap /swapfile; fi
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap defaults 0 0' >> /etc/fstab
  swapon -a
  # 3. users (D6): fixed uid/gid; nginx joins group cloudalbum (X-Accel-Redirect needs it)
  getent group cloudalbum >/dev/null || groupadd --system --gid "$CA_ID" cloudalbum
  id -u cloudalbum >/dev/null 2>&1 || useradd --system --uid "$CA_ID" --gid "$CA_ID" \
      --home-dir "$DATA" --no-create-home --shell /sbin/nologin cloudalbum
  [ "$(id -u cloudalbum):$(id -g cloudalbum)" = "$CA_ID:$CA_ID" ] || { echo "FATAL: uid/gid of cloudalbum is not $CA_ID"; exit 1; }
  usermod -aG cloudalbum nginx
  # 4. release: /opt/cloudalbum is a symlink to a version directory (scripts/deploy switches it)
  if [ ! -f /opt/cloudalbum/.image-manifest.json ]; then
    if [ ! -f "$ARCHIVE" ]; then
      case "$APP_ARCHIVE_URL" in
        s3://*) aws s3 cp "$APP_ARCHIVE_URL" "$ARCHIVE" --region "$AWS_REGION" ;;
        *)      curl -fsSL "$APP_ARCHIVE_URL" -o "$ARCHIVE" ;;
      esac
    fi
    echo "$APP_ARCHIVE_SHA256  $ARCHIVE" | sha256sum -c -
    ver=$(tar xzf "$ARCHIVE" -O --wildcards '*/VERSION' | head -1)
    [[ $ver =~ ^[A-Za-z0-9._-]+$ ]] || { echo "FATAL: invalid VERSION in the release archive"; exit 1; }
    rel=/opt/cloudalbum-releases/$ver
    # extract into a temporary sibling directory (same file system) and rename only after tar succeeded: an interrupted
    # extraction (disk full, instance stopped) never leaves a half-extracted $rel that a re-run would skip and link to
    if [ ! -f "$rel/.extract-complete" ]; then
      rm -rf "$rel".tmp.* "$rel".incomplete.*                          # leftovers of an interrupted earlier run
      install -d "$rel.tmp.$$"
      tar xzf "$ARCHIVE" -C "$rel.tmp.$$" --strip-components=1
      touch "$rel.tmp.$$/.extract-complete"
      if [ -e "$rel" ]; then mv -T "$rel" "$rel.incomplete.$$"; fi     # unmarked directory: replaced, not trusted
      mv -T "$rel.tmp.$$" "$rel"
      rm -rf "$rel.incomplete.$$"
    fi
    ln -sfn "$rel" /opt/cloudalbum
  fi
  # 5. host files: nginx.conf (replaces the distribution default), cloudalbum.conf / locations / proxy / upstream,
  #    00-entry, 00-acme-challenge, slots and vpc-cidr placeholders, systemd units and drop-in directories, nginx hardening
  #    drop-in, logrotate, journald limit, sshd hardening (sshd -t), fail2ban filter / action, helpers and cloudalbum-* commands
  bash /opt/cloudalbum/infra/install-host-files.sh
  # platform mode (06 PM-04, both modes install the check bundle when the release ships it; golden AMIs re-verify it)
  if [ -f /opt/cloudalbum/infra/host/install-atl-bundle.sh ]; then bash /opt/cloudalbum/infra/host/install-atl-bundle.sh; fi
  if [ "$PLATFORM_MODE" = on ]; then ssm_agent_check; fi
  systemctl enable --now chronyd
  systemctl daemon-reload
}

attach_data_volume() {   # single mode only
  local dev=/dev/sdf u g
  for _ in $(seq 1 60); do [ -e "$dev" ] && break; sleep 2; done      # AL2023 udev rules create /dev/sdf for the NVMe volume
  [ -e "$dev" ] || { echo "FATAL: data volume $dev not present"; exit 1; }
  if ! blkid -p "$dev" >/dev/null 2>&1; then                          # E5: only format a volume this stack just created
    # A fresh EBS volume is not guaranteed to read back as zeros, so "first MiB is zero" is not a usable test.
    # The stack tells us whether DataVolume was created by it (new) or handed over via DataVolumeId (existing).
    [ "${DATA_VOLUME_ORIGIN:-existing}" = new ] || { echo "FATAL: $dev has no recognizable file system and was not created by this stack (DATA_VOLUME_ORIGIN=${DATA_VOLUME_ORIGIN:-unset}), refusing to format"; exit 1; }
    mkfs.xfs -L cadata "$dev"
  fi
  install -d -m 0755 "$DATA"
  grep -q '^LABEL=cadata ' /etc/fstab || echo 'LABEL=cadata /var/lib/cloudalbum xfs defaults,nofail,noatime 0 2' >> /etc/fstab
  systemctl daemon-reload
  mountpoint -q "$DATA" || mount "$DATA"
  mountpoint -q "$DATA" || { echo "FATAL: data volume not mounted"; exit 1; }
  xfs_growfs "$DATA" >/dev/null                                        # takes effect after an online resize; no-op otherwise
  u=$(stat -c %u "$DATA"); g=$(stat -c %g "$DATA")
  if [ "$u" != 0 ] && [ "$u:$g" != "$CA_ID:$CA_ID" ]; then             # volumes created by older versions used a random uid (D6)
    echo "data volume owned by $u:$g, normalizing to $CA_ID:$CA_ID"; chown -R --from="$u:$g" "$CA_ID:$CA_ID" "$DATA"
  fi
}

prepare_dirs() {
  local d
  install -d -o cloudalbum -g cloudalbum -m 0750 "$DATA"
  for d in db uploads uploads/.incoming outbox logs logs/spans backup migrate lab; do
    install -d -o cloudalbum -g cloudalbum -m 0750 "$DATA/$d"; done
  install -d -o root -g cloudalbum -m 0750 "$ETC" "$ETC/modules.d" "$ETC/keys" "$ETC/tls" \
                                         "$DATA/acme" "$DATA/acme/.well-known" "$DATA/acme/.well-known/acme-challenge"
  install -d -o root -g cloudalbum -m 2770 "$DATA/security"           # E8
  [ -e "$DATA/security/denylist.conf" ] || install -o cloudalbum -g cloudalbum -m 0640 /dev/null "$DATA/security/denylist.conf"
  # D5: /etc/cloudalbum always points to the data volume; an old real directory on the root volume only contributes
  # files the data volume does not have yet
  if [ -d /etc/cloudalbum ] && [ ! -L /etc/cloudalbum ]; then
    cp -an /etc/cloudalbum/. "$ETC"/ && mv /etc/cloudalbum "/etc/cloudalbum.pre-volume.$(date +%s)"
  fi
  ln -sfn "$ETC" /etc/cloudalbum
}

write_base_config() {    # first time only; afterwards maintained by scripts/module (total outline 4.4 layer 1)
  local f
  if [ ! -f "$ETC/cloudalbum.env" ]; then
    ( umask 027; printf 'AWS_REGION=%s\nCLOUDALBUM_ENV=%s\nAPP_BASE_URL=http://%s\nDEPLOY_MODE=%s\n' \
        "$AWS_REGION" "$CLOUDALBUM_ENV" "${APP_PUBLIC_IP:-127.0.0.1}" "$DEPLOY_MODE" > "$ETC/cloudalbum.env.tmp" )
    chgrp cloudalbum "$ETC/cloudalbum.env.tmp"; mv "$ETC/cloudalbum.env.tmp" "$ETC/cloudalbum.env"
  fi
  for f in runtime.json alerts.yaml; do                   # defaults come from the release; existing files are kept
    [ -f "$ETC/$f" ] || install -o root -g cloudalbum -m 0640 "/opt/cloudalbum/infra/defaults/$f" "$ETC/$f"; done
  [ -f "$ETC/fail2ban-ignoreip" ] || install -o root -g root -m 0644 /dev/null "$ETC/fail2ban-ignoreip"
}

ensure_secrets() {       # D5 + invariant 1: only when the data volume is mounted and has no secrets yet
  local S=$ETC/secrets.env K=$ETC/keys/jwt-es256.pem n
  [ "$DEPLOY_MODE" = asg ] || mountpoint -q "$DATA" || { echo "FATAL: data volume not mounted, refusing to generate secrets"; exit 1; }
  if [ -f "$S" ] && grep -Eq '^SECRETS_ORIGIN=(aws|bundle)$' "$S"; then return 0; fi   # managed by secrets / the bootstrap bundle
  if [ ! -f "$S" ]; then
    if [ "$REGEN_SECRETS" != yes ] && { [ -e "$ETC/.initialized" ] || [ -e "$DATA/db/cloudalbum.sqlite" ] || [ "$DEPLOY_MODE" = asg ]; }; then
      echo "FATAL: the data volume is initialized (or asg mode) but secrets.env is missing: refusing to regenerate. Restore $S"
      echo "       from a snapshot / backup. To give up every encrypted field and session: cloudalbum-postattach --regenerate-secrets"
      exit 1
    fi
    if [ "$REGEN_SECRETS" = yes ] && [ "$DEPLOY_MODE" = single ]; then
      echo "WARN: --regenerate-secrets: encrypted fields (MFA secrets, photo locations) and every session are given up"
      echo "      (cli keys:reset-fingerprint --confirm-data-loss runs after db:migrate)"
      install -o root -g cloudalbum -m 0640 /dev/null "$REGEN_MARKER"
    fi
    ( umask 027
      { echo "SECRETS_ORIGIN=instance"
        for n in UPLOAD_HMAC_KEY MEDIA_HMAC_KEY CALLBACK_HMAC_KEY INTERNAL_HMAC_KEY COOKIE_SECRET LOCAL_MASTER_KEY; do
          echo "$n=$(openssl rand -base64 32)"; done
        echo "JWT_SIGNING_KEY_FILE=/etc/cloudalbum/keys/jwt-es256.pem"; } > "$S.tmp" )
    chown root:cloudalbum "$S.tmp"; chmod 0640 "$S.tmp"; mv "$S.tmp" "$S"
  fi
  if [ ! -f "$K" ]; then                                   # D8: ES256 (P-256) signing key
    [ -e "$ETC/.initialized" ] && echo "WARN: JWT signing key missing, regenerating: every issued token becomes invalid (data unaffected)"
    ( umask 027; openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$K.tmp" )
    chown root:cloudalbum "$K.tmp"; chmod 0640 "$K.tmp"; mv "$K.tmp" "$K"
  fi
}

ensure_tls_selfsigned() {  # control group of the tls module; tls only switches the server.crt / server.key symlinks
  local T=$ETC/tls
  [ -e "$T/server.crt" ] && return 0
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=cloudalbum-l0" \
    -addext "subjectAltName=IP:${APP_PUBLIC_IP:-127.0.0.1}" -keyout "$T/selfsigned.key" -out "$T/selfsigned.crt"
  chmod 0600 "$T/selfsigned.key"; chmod 0644 "$T/selfsigned.crt"
  ln -sfn selfsigned.crt "$T/server.crt"; ln -sfn selfsigned.key "$T/server.key"
}

postattach_phase() {
  local pw
  if [ "$DEPLOY_MODE" = single ]; then attach_data_volume; fi
  prepare_dirs
  if [ "$DEPLOY_MODE" = asg ]; then "$LIB/run-hostsetup.sh" autoscaling; fi   # bootstrap bundle: modules.d, secrets.env, keys (01#autoscaling)
  write_base_config
  ensure_secrets
  ensure_tls_selfsigned
  "$LIB/render-vpc-cidr.sh"           # /etc/nginx/cloudalbum-vpc-cidr.inc <- IMDS vpc-ipv4-cidr-blocks (updated after network moves)
  "$LIB/run-hostsetup.sh" --all       # E12: hostSetup apply for every enabled module in registry topological order
  "$LIB/render-fail2ban.sh"           # ban method depends on the entry (behind cdn / load-balancer or not)
  # platform mode (06 PM-01/02/20): platform.env lives on the data volume, its Nginx slot on the root volume -> re-render it
  if [ -f "$ETC/platform.env" ]; then bash /opt/cloudalbum/infra/host/platform/apply-env.sh --resync >/dev/null; fi
  cli check-config                    # configuration error -> exit 78, the script stops (D3)
  if [ "$DEPLOY_MODE" = single ]; then
    cli db:migrate
    if [ -e "$REGEN_MARKER" ]; then
      # the old LOCAL_MASTER_KEY is gone: clear the fields it encrypted and record the new fingerprint (explicit, logged);
      # without this the comparison below would fail with 78 forever
      cli keys:reset-fingerprint --confirm-data-loss
      rm -f "$REGEN_MARKER"
    fi
    cli keys:check-fingerprint        # compared with system_meta; mismatch -> 78 (CFG-007)
    if [ "$PLATFORM_MODE" != on ] && [ -n "$ADMIN_EMAIL" ]; then   # platform mode: the runner creates the admin (PM-07)
      pw=$(cli admin:ensure --email "$ADMIN_EMAIL" --print-password-if-created)
      [ -z "$pw" ] || ( umask 077; printf '%s\n' "$pw" > /root/cloudalbum-admin.txt )
    fi
  fi
  "$LIB/denylist-apply.sh" --sync     # root-owned, validated copy of security/denylist.conf for Nginx
  nginx -t
  systemctl enable --now nginx cloudalbum-api cloudalbum-worker cloudalbum-denylist.path \
    cloudalbum-backup.timer cloudalbum-security-snapshot.timer cloudalbum-healthcheck.timer cloudalbum-vuln-scan.timer
  if rpm -q fail2ban-server >/dev/null 2>&1; then systemctl enable --now fail2ban; fi
  for _ in $(seq 1 60); do curl -fsS -m 3 'http://127.0.0.1/api/health/ready?scope=instance' >/dev/null && break; sleep 2; done
  curl -fsS -m 3 'http://127.0.0.1/api/health/ready?scope=instance' >/dev/null || { journalctl -u cloudalbum-api -n 50 --no-pager; exit 1; }
  if [ "$DEPLOY_MODE" = single ]; then touch "$ETC/.initialized"; fi
  echo "KEY_FINGERPRINT=$(cli keys:fingerprint)"   # compared by scripts/module with state.json (invariant 3)
}

case "$PHASE" in
  install)    install_phase ;;
  postattach) postattach_phase ;;
  all)        install_phase
              want=$(imds tags/instance/CloudAlbumDataVolume 2>/dev/null || echo attach)
              if [ "$DEPLOY_MODE" = asg ] || [ "$want" = attach ]; then postattach_phase
              else echo "install-only: CloudAlbumDataVolume=$want; scripts/module runs cloudalbum-postattach after attaching the volume"; fi
              signal 0 ;;
  *)          echo "usage: $0 all|install|postattach [--regenerate-secrets]"; exit 64 ;;
esac
