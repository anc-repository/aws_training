#!/bin/bash
# infra/modules/tls/host-setup.sh — tls hostSetup (registry; 00-ec2-base.md 6.8 / 6.9; 01#tls sections 1, 2, 6).
# Root, idempotent; apply / revert depend only on "release + modules.d/tls.env" (replay contract E12).
#
#   apply                 TLS_MODE=acm + TLS_ACME=on : /opt/certbot virtualenv; when the ACME lineage exists, point
#                                                      /etc/cloudalbum/tls/server.{crt,key} at it; renew timer on
#                         TLS_MODE=acm + TLS_ACME=off: Nginx keeps self-signed / Let's Encrypt (fallback branch: ACM only
#                                                      on CloudFront / ALB); an old ACME link goes back to self-signed
#                         TLS_MODE=letsencrypt (local tier, TLS_DOMAIN set): issue once over HTTP-01 webroot when no
#                                                      lineage exists (failure keeps the self-signed certificate), link it
#                         TLS_PREVIEW=letsencrypt-ip : nothing (platform preview scheme B owns the certificate, 06 PM-21)
#                         TLS_FORCE_HTTPS=true (only with a trusted certificate on Nginx, DEP-015): 80 -> 443 redirect through the
#                         ec2 variable $ca_https_redirect (never loopback / ACME HTTP-01 / CloudFront / ALB) + HSTS
#                         (TLS_HSTS_MAX_AGE, default 300 s; not sent to loopback); otherwise both fragments are removed
#   revert                symlinks back to the self-signed certificate, renew timer off. The certbot account and the
#                         lineage stay (a rollback must not force a new, billed ACME issuance); `purge-acme` removes them.
#   issue-acme --server <directory URL> --domain <name> [--email <addr>] [--eab-param <SSM name> --region <r>]
#                         one-time EAB registration + issuance at the ACM ACME endpoint (called by scripts/module enable
#                         tls). EAB credentials come from CA_EAB_KID / CA_EAB_HMAC (ssh stdin) or from a SecureString
#                         parameter (SSM channel); they are never written to disk. Prints one JSON line.
#   renew                 cloudalbum-tls-renew.timer (twice a day): certbot renew of the module lineage (or tls-preview.sh
#                         renew for scheme B); writes /var/lib/cloudalbum/tls/renew-status.json for the tls detector
#   deploy-hook           certbot --deploy-hook: nginx -t + reload through nginx-reload.sh
#   renew-drill [--force] experiments/tls renew-drill: certbot renew --dry-run (+ --force-renewal); JSON before/after
#   revoke-acme           optional on disable: ACME revoke-cert of the lineage (ACM RevokeCertificate cannot revoke it)
#   purge-acme --server <directory URL>   disable step 7: delete the lineage and the ACME account of that endpoint
#   status                JSON of the certificate Nginx serves
#
# Paths (data volume, D5): certbot --config-dir /etc/cloudalbum/letsencrypt (TLS_CERTBOT_CONFIG_DIR), --work-dir
# /var/lib/cloudalbum/certbot/work, --logs-dir /var/lib/cloudalbum/logs/certbot, webroot /var/lib/cloudalbum/acme (served by
# the ec2 fragment 00-acme-challenge.conf). Private keys and the ACME account key: root 0600, never in modules.d / secrets.env.
set -euo pipefail
umask 027

ETC=$(readlink -f /etc/cloudalbum)
TLS=$ETC/tls
ENV_FILE=${CLOUDALBUM_MODULE_ENV:-$ETC/modules.d/tls.env}
DATA=/var/lib/cloudalbum
WORK=$DATA/certbot/work
LOGS=$DATA/logs/certbot
WEBROOT=$DATA/acme
STATUS_DIR=$DATA/tls
STATUS=$STATUS_DIR/renew-status.json
VENV=/opt/certbot
LIB=/usr/local/lib/cloudalbum
SYSD=/etc/systemd/system
DROPIN_DIR=$SYSD/cloudalbum-tls-renew.service.d
DROPIN=$DROPIN_DIR/50-tls.conf
SELF=/opt/cloudalbum/infra/modules/tls/host-setup.sh
ACME_CERT=cloudalbum-acm
LE_CERT=cloudalbum-le
HOST_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$'
FORCE_MAP=/etc/nginx/cloudalbum.d/tls-hsts.conf
FORCE_SERVER=/etc/nginx/cloudalbum.server.d/tls-force-https.conf
CERTBOT=''

action=${1:-apply}
shift || true

env_value() {   # env_value <KEY> -> value from modules.d/tls.env (no shell evaluation)
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed -e 's/[[:space:]]#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

MODE=$(env_value TLS_MODE); MODE=${MODE:-selfsigned}
ACME=$(env_value TLS_ACME); ACME=${ACME:-off}
DOMAIN=$(env_value TLS_DOMAIN)
PREVIEW=$(env_value TLS_PREVIEW)
CONFIG=$(env_value TLS_CERTBOT_CONFIG_DIR); CONFIG=${CONFIG:-/etc/cloudalbum/letsencrypt}
case "$CONFIG" in /etc/cloudalbum/*) CONFIG=$ETC/${CONFIG#/etc/cloudalbum/} ;; esac

json_out() { printf '%s\n' "$1"; }
log() { echo "tls host-setup: $*" >&2; }

certbot_dirs() { echo --config-dir "$CONFIG" --work-dir "$WORK" --logs-dir "$LOGS"; }

ensure_dirs() {
  install -d -m 0750 -o root -g root "$CONFIG" "$WORK" "$LOGS"
  install -d -m 0755 "$WEBROOT" "$STATUS_DIR"
}

ensure_certbot() {   # /opt/certbot virtualenv (pip; AL2023's repositories may not carry certbot); fallback: dnf certbot
  if [ -x "$VENV/bin/certbot" ]; then CERTBOT=$VENV/bin/certbot; return 0; fi
  local py=''
  for c in python3.12 python3.11 python3; do if command -v "$c" >/dev/null 2>&1; then py=$c; break; fi; done
  if [ -n "$py" ] && "$py" -m venv "$VENV" >/dev/null 2>&1 \
     && "$VENV/bin/pip" install --quiet --disable-pip-version-check "${CERTBOT_PIP_SPEC:-certbot>=2.11}" >/dev/null 2>&1; then
    CERTBOT=$VENV/bin/certbot; return 0
  fi
  rm -rf "$VENV"
  if command -v certbot >/dev/null 2>&1 || dnf -y install certbot >/dev/null 2>&1; then CERTBOT=$(command -v certbot); return 0; fi
  log "no ACME client: python3 -m venv + pip install certbot failed and dnf has no certbot"
  return 1
}

lineage_exists() { [ -s "$CONFIG/live/$1/fullchain.pem" ] && [ -s "$CONFIG/live/$1/privkey.pem" ]; }

link_to() {   # link_to selfsigned | <lineage>
  if [ "$1" = selfsigned ]; then
    [ -e "$TLS/selfsigned.crt" ] || { log "self-signed certificate missing in $TLS (l0-bootstrap.sh ensure_tls_selfsigned)"; return 1; }
    ln -sfn selfsigned.crt "$TLS/server.crt"; ln -sfn selfsigned.key "$TLS/server.key"; return 0
  fi
  local base="$CONFIG/live/$1"
  [ "$CONFIG" = "$ETC/letsencrypt" ] && base="../letsencrypt/live/$1"   # relative: survives a different mount point
  ln -sfn "$base/fullchain.pem" "$TLS/server.crt"; ln -sfn "$base/privkey.pem" "$TLS/server.key"
}

current_lineage() { readlink "$TLS/server.crt" 2>/dev/null | sed -n 's#.*/live/\([^/]*\)/fullchain.pem$#\1#p'; }

cert_json() {   # cert_json <pem> -> {"subject":…,"issuer":…,"serial":…,"notAfter":…}
  local f=$1
  [ -s "$f" ] || { echo 'null'; return 0; }
  jq -n --arg subject "$(openssl x509 -in "$f" -noout -subject 2>/dev/null | sed 's/^subject=[[:space:]]*//')" \
    --arg issuer "$(openssl x509 -in "$f" -noout -issuer 2>/dev/null | sed 's/^issuer=[[:space:]]*//')" \
    --arg serial "$(openssl x509 -in "$f" -noout -serial 2>/dev/null | sed 's/^serial=//')" \
    --arg notAfter "$(openssl x509 -in "$f" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')" \
    '{subject: $subject, issuer: $issuer, serial: $serial, notAfter: $notAfter}'
}

install_renew() {   # the tls module owns cloudalbum-tls-renew.*; ec2 installs the units for scheme B, the drop-in repoints them
  if [ ! -f "$SYSD/cloudalbum-tls-renew.timer" ]; then
    cat > "$SYSD/cloudalbum-tls-renew.service" <<'EOF'
# owned by the tls module (infra/modules/tls/host-setup.sh)
[Unit]
Description=CloudAlbum tls: certificate renewal
After=network-online.target nginx.service

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/cloudalbum/infra/modules/tls/host-setup.sh renew
EOF
    cat > "$SYSD/cloudalbum-tls-renew.timer" <<'EOF'
# owned by the tls module (infra/modules/tls/host-setup.sh): twice a day
[Unit]
Description=CloudAlbum tls: certificate renewal every 12 hours

[Timer]
OnBootSec=10min
OnUnitActiveSec=12h
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF
    chmod 0644 "$SYSD/cloudalbum-tls-renew.service" "$SYSD/cloudalbum-tls-renew.timer"
  fi
  install -d -m 0755 "$DROPIN_DIR"
  printf '%s\n' '# tls module (infra/modules/tls/host-setup.sh): renew the module lineage; scheme B is delegated to tls-preview.sh' \
    '[Service]' 'ExecStart=' "ExecStart=/bin/bash $SELF renew" > "$DROPIN"
  chmod 0644 "$DROPIN"
  systemctl daemon-reload
  systemctl enable --now cloudalbum-tls-renew.timer >/dev/null 2>&1 || log "could not enable cloudalbum-tls-renew.timer"
}

uninstall_renew() {
  rm -f "$DROPIN"
  rmdir "$DROPIN_DIR" 2>/dev/null || true
  systemctl daemon-reload
  if [ "$PREVIEW" != letsencrypt-ip ]; then systemctl disable --now cloudalbum-tls-renew.timer >/dev/null 2>&1 || true; fi
}

write_status() {   # write_status <ok:true|false> <exitCode> <certName>
  install -d -m 0755 "$STATUS_DIR"
  local tmp
  tmp=$(mktemp "$STATUS_DIR/.renew.XXXXXX")
  jq -n --argjson ok "$1" --argjson code "$2" --arg cert "$3" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson current "$(cert_json "$TLS/server.crt")" \
    '{at: $at, ok: $ok, exitCode: $code, certName: $cert, current: $current}' > "$tmp"
  chmod 0644 "$tmp"; mv -f "$tmp" "$STATUS"
}

force_https() {   # force_https on|off — fragments of TLS_FORCE_HTTPS (80/443 server block only; the cdn 8080 listener never includes them)
  if [ "$1" != on ]; then rm -f "$FORCE_MAP" "$FORCE_SERVER"; return 0; fi
  local age
  age=$(env_value TLS_HSTS_MAX_AGE); age=${age:-300}
  [[ $age =~ ^[0-9]{1,8}$ ]] || { log "TLS_HSTS_MAX_AGE must be a number of seconds: '$age'"; return 1; }
  cat > "$FORCE_MAP.tmp" <<EOF
# tls module (infra/modules/tls/host-setup.sh): HSTS value; empty for plain HTTP and loopback (06 PM-19)
map "\$scheme:\$realip_remote_addr" \$ca_tls_hsts {
    default "";
    "~^https:(127\.|::1\$)" "";
    "~^https:" "max-age=$age";
}
EOF
  cat > "$FORCE_SERVER.tmp" <<'EOF'
# tls module (infra/modules/tls/host-setup.sh): TLS_FORCE_HTTPS=true — direct plain HTTP only ($ca_https_redirect of ec2:
# never loopback, ACME HTTP-01, CloudFront or ALB)
if ($ca_https_redirect) { return 301 https://$host$request_uri; }
# inherited by the locations without their own add_header (SPA fallback, /api/): enough for the browser to cache HSTS
add_header Strict-Transport-Security $ca_tls_hsts always;
EOF
  chmod 0644 "$FORCE_MAP.tmp" "$FORCE_SERVER.tmp"
  mv -f "$FORCE_MAP.tmp" "$FORCE_MAP"; mv -f "$FORCE_SERVER.tmp" "$FORCE_SERVER"
}

trusted_lineage_linked() { case "$(current_lineage)" in "$ACME_CERT"|"$LE_CERT") return 0 ;; *) return 1 ;; esac; }

module_lineage() {   # the lineage this configuration renews ('' = none)
  if [ "$MODE" = acm ] && [ "$ACME" = on ]; then echo "$ACME_CERT"
  elif [ "$MODE" = letsencrypt ] && [ -n "$DOMAIN" ] && [ "$PREVIEW" != letsencrypt-ip ]; then echo "$LE_CERT"
  elif [ "$MODE" = acm ] && [ "$(current_lineage)" = "$LE_CERT" ]; then echo "$LE_CERT"   # fallback branch kept Let's Encrypt
  fi
}

set_renew_window() {   # 45-day ACME certificates: renew with 15 days (1/3 of the lifetime) left
  local conf="$CONFIG/renewal/$1.conf"
  [ -f "$conf" ] || return 0
  if grep -q '^renew_before_expiry' "$conf"; then sed -i "s/^renew_before_expiry.*/renew_before_expiry = $2/" "$conf"
  else sed -i "1i renew_before_expiry = $2" "$conf"; fi
}

account_url() {   # account_url <server URL> -> ACME account URL from certbot's regr.json
  local host path dir
  host=$(sed -E 's#^https://([^/]+)/.*#\1#' <<< "$1"); path=$(sed -E 's#^https://[^/]+/##' <<< "$1")
  dir="$CONFIG/accounts/$host/$path"
  find "$dir" -name regr.json -print -quit 2>/dev/null | xargs -r jq -r '.uri // empty' 2>/dev/null || true
}

issue_le() {   # local tier: Let's Encrypt over HTTP-01 webroot (port 80 must be reachable from the internet)
  local email profile args=()
  email=$(env_value TLS_LE_EMAIL); profile=$(env_value TLS_LE_PROFILE)
  if [ -n "$email" ]; then args+=(--email "$email"); else args+=(--register-unsafely-without-email); fi
  if [ -n "$profile" ]; then args+=(--preferred-profile "$profile"); fi
  # shellcheck disable=SC2046
  "$CERTBOT" certonly --webroot -w "$WEBROOT" --non-interactive --agree-tos --keep-until-expiring --cert-name "$LE_CERT" \
    -d "$DOMAIN" "${args[@]}" $(certbot_dirs)
}

case "$action" in
  apply)
    if [ "$PREVIEW" = letsencrypt-ip ]; then log "platform preview scheme B owns the certificate (tls-preview.sh)"; exit 0; fi
    ensure_dirs
    if [ "$MODE" = acm ] && [ "$ACME" = on ]; then
      [[ $DOMAIN =~ $HOST_RE ]] || { log "TLS_MODE=acm needs TLS_DOMAIN (DEP-005 1): '$DOMAIN'"; exit 1; }
      # the certificate lives on the data volume; certbot (root volume) is only needed for renewal: a replay without network
      # (postattach) must not fail the boot — the renew status turns the tls probe degraded instead
      ensure_certbot || log "certbot unavailable: the certificate stays in use, renewal fails until it can be installed"
      if lineage_exists "$ACME_CERT"; then
        set_renew_window "$ACME_CERT" '15 days'
        link_to "$ACME_CERT"
      else
        log "ACME certificate not issued yet: scripts/module enable tls runs 'host-setup.sh issue-acme'; Nginx keeps $(current_lineage || true) / self-signed"
      fi
      install_renew
    elif [ "$MODE" = acm ]; then
      # fallback branch: ACM only on CloudFront / ALB; Nginx keeps self-signed or Let's Encrypt
      if [ "$(current_lineage)" = "$ACME_CERT" ]; then link_to selfsigned; fi
      if [ "$(current_lineage)" = "$LE_CERT" ]; then install_renew; else uninstall_renew; fi
    elif [ "$MODE" = letsencrypt ] && [ -n "$DOMAIN" ]; then
      [[ $DOMAIN =~ $HOST_RE ]] || { log "TLS_DOMAIN is not a host name: '$DOMAIN'"; exit 1; }
      if ! ensure_certbot; then
        log "certbot unavailable: no Let's Encrypt issuance now"
      elif ! lineage_exists "$LE_CERT" && ! issue_le; then
        log "Let's Encrypt issuance failed (A record -> EIP? port 80 open?); keeping the current certificate"
      fi
      if lineage_exists "$LE_CERT"; then link_to "$LE_CERT"; fi
      install_renew
    else
      link_to selfsigned
      uninstall_renew
    fi
    force=$(env_value TLS_FORCE_HTTPS)
    if [ "$force" = true ] && ! trusted_lineage_linked; then
      log "TLS_FORCE_HTTPS=true but Nginx has no trusted certificate yet: redirect and HSTS stay off (self-signed + HSTS locks users out, DEP-015)"
      force=false
    fi
    force_https "$([ "$force" = true ] && echo on || echo off)" ;;

  revert)
    if [ "$PREVIEW" = letsencrypt-ip ]; then exit 0; fi
    force_https off
    link_to selfsigned
    uninstall_renew
    rm -f "$STATUS" ;;

  issue-acme)
    server=''; domain=''; email=''; eab_param=''; region=''
    while [ $# -gt 0 ]; do
      case "$1" in
        --server) server=${2:-}; shift 2 ;;
        --domain) domain=${2:-}; shift 2 ;;
        --email) email=${2:-}; shift 2 ;;
        --eab-param) eab_param=${2:-}; shift 2 ;;
        --region) region=${2:-}; shift 2 ;;
        *) json_out '{"issued":false,"reason":"unknown option"}'; exit 64 ;;
      esac
    done
    [[ $server =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]*$ ]] || { json_out '{"issued":false,"reason":"--server must be the https ACME directory URL"}'; exit 64; }
    [[ $domain =~ $HOST_RE ]] || { json_out '{"issued":false,"reason":"--domain must be a lower-case host name"}'; exit 64; }
    kid=${CA_EAB_KID:-}; hmac=${CA_EAB_HMAC:-}
    if [ -n "$eab_param" ]; then
      # SSM channel: the instance role reads the hand-off parameter (standalone: shell-access policy HandoffRead on
      # /cloudalbum/<env>/handoff/*; platform: AmazonSSMManagedInstanceCore). A clear reason instead of a bare set -e exit.
      if ! eab=$(aws ssm get-parameter --region "$region" --name "$eab_param" --with-decryption --query Parameter.Value --output text 2>/dev/null); then
        json_out '{"issued":false,"reason":"cannot read the EAB hand-off parameter: the instance role needs ssm:GetParameter on /cloudalbum/<env>/handoff/* (shell-access policy statement HandoffRead)"}'
        exit 1
      fi
      kid=$(jq -r '.KeyId' <<< "$eab"); hmac=$(jq -r '.MacKey' <<< "$eab"); unset eab
    fi
    ensure_dirs
    ensure_certbot || { json_out '{"issued":false,"reason":"no ACME client (certbot)"}'; exit 1; }
    args=()
    if [ -n "$email" ]; then args+=(--email "$email"); else args+=(--register-unsafely-without-email); fi
    if [ -n "$kid" ] && [ -n "$hmac" ]; then args+=(--eab-kid "$kid" --eab-hmac-key "$hmac"); fi
    unset kid hmac CA_EAB_KID CA_EAB_HMAC
    # official guidance: issuance can take about 2 minutes, the client timeout must be at least 120 s. --webroot instead of
    # --standalone so Nginx keeps port 80; with PRE_APPROVED no validation request is expected to arrive.
    # shellcheck disable=SC2046
    if ! log_out=$("$CERTBOT" certonly --webroot -w "$WEBROOT" --non-interactive --agree-tos --keep-until-expiring \
          --server "$server" --issuance-timeout 120 --cert-name "$ACME_CERT" --key-type ecdsa --elliptic-curve secp256r1 \
          -d "$domain" "${args[@]}" $(certbot_dirs) 2>&1); then
      unset args
      reason=$(printf '%s' "$log_out" | tail -3 | tr -d '"\\' | tr '\n' ' ' | cut -c1-300)
      json_out "{\"issued\":false,\"reason\":\"$reason\"}"; exit 1
    fi
    unset args
    set_renew_window "$ACME_CERT" '15 days'
    jq -cn --arg cert "$ACME_CERT" --arg account "$(account_url "$server")" --argjson c "$(cert_json "$CONFIG/live/$ACME_CERT/cert.pem")" \
      '{issued: true, certName: $cert, account: $account, certificate: $c}' ;;

  renew)
    if [ "$PREVIEW" = letsencrypt-ip ]; then exec bash /opt/cloudalbum/infra/host/platform/tls-preview.sh renew; fi
    name=$(module_lineage)
    if [ -z "$name" ] || ! lineage_exists "$name"; then json_out '{"renewed":false,"reason":"no module certificate to renew"}'; exit 0; fi
    ensure_certbot || { write_status false 127 "$name"; exit 1; }
    code=0
    # shellcheck disable=SC2046
    "$CERTBOT" renew --non-interactive --cert-name "$name" --deploy-hook "/bin/bash $SELF deploy-hook" $(certbot_dirs) || code=$?
    if [ "$code" = 0 ]; then write_status true 0 "$name"; else write_status false "$code" "$name"; fi
    exit "$code" ;;

  deploy-hook)
    "$LIB/nginx-reload.sh" ;;

  renew-drill)
    force=0
    [ "${1:-}" = --force ] && force=1
    name=$(module_lineage)
    if [ -z "$name" ] || ! lineage_exists "$name"; then json_out '{"drill":false,"reason":"no module certificate (TLS_MODE=acm with TLS_ACME=on, or letsencrypt)"}'; exit 2; fi
    ensure_certbot || exit 1
    before=$(cert_json "$CONFIG/live/$name/cert.pem")
    dry=0
    # shellcheck disable=SC2046
    "$CERTBOT" renew --dry-run --non-interactive --cert-name "$name" $(certbot_dirs) >/dev/null 2>&1 || dry=$?
    forced=null
    if [ "$force" = 1 ]; then
      fc=0
      # shellcheck disable=SC2046
      "$CERTBOT" renew --force-renewal --non-interactive --cert-name "$name" --deploy-hook "/bin/bash $SELF deploy-hook" $(certbot_dirs) >/dev/null 2>&1 || fc=$?
      forced=$fc
      write_status "$([ "$fc" = 0 ] && echo true || echo false)" "$fc" "$name"
    fi
    jq -cn --arg cert "$name" --argjson dry "$dry" --argjson forced "$forced" --argjson before "$before" \
      --argjson after "$(cert_json "$CONFIG/live/$name/cert.pem")" \
      '{drill: true, certName: $cert, dryRunExit: $dry, forceRenewalExit: $forced, before: $before, after: $after}' ;;

  revoke-acme)
    lineage_exists "$ACME_CERT" || { json_out '{"revoked":false,"reason":"no ACME lineage"}'; exit 0; }
    ensure_certbot || exit 1
    [ "$(current_lineage)" = "$ACME_CERT" ] && link_to selfsigned && "$LIB/nginx-reload.sh" || true
    # shellcheck disable=SC2046
    "$CERTBOT" revoke --non-interactive --cert-name "$ACME_CERT" --delete-after-revoke $(certbot_dirs)
    json_out '{"revoked":true}' ;;

  purge-acme)
    server=''
    [ "${1:-}" = --server ] && server=${2:-}
    if [ "$(current_lineage)" = "$ACME_CERT" ]; then link_to selfsigned; "$LIB/nginx-reload.sh" || true; fi
    if lineage_exists "$ACME_CERT" || [ -f "$CONFIG/renewal/$ACME_CERT.conf" ]; then
      if ensure_certbot; then
        # shellcheck disable=SC2046
        "$CERTBOT" delete --non-interactive --cert-name "$ACME_CERT" $(certbot_dirs) >/dev/null 2>&1 || true
      fi
    fi
    if [[ $server =~ ^https://([A-Za-z0-9.-]+)/(.*)$ ]]; then
      rm -rf "${CONFIG:?}/accounts/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    fi
    json_out '{"purged":true}' ;;

  status)
    jq -cn --arg mode "$MODE" --arg acme "$ACME" --arg link "$(readlink "$TLS/server.crt" 2>/dev/null || true)" \
      --argjson current "$(cert_json "$TLS/server.crt")" \
      --argjson renew "$( [ -s "$STATUS" ] && cat "$STATUS" || echo null)" \
      '{mode: $mode, acme: $acme, link: $link, current: $current, lastRenew: $renew}' ;;

  *)
    echo "usage: $0 apply|revert|issue-acme|renew|deploy-hook|renew-drill|revoke-acme|purge-acme|status" >&2; exit 64 ;;
esac
