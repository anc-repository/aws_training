#!/bin/bash
# infra/host/platform/tls-preview.sh on --ip <EIP> | off | renew | status   (root; 06 PM-21, platform preview scheme B)
#   on    : Let's Encrypt short-lived IP certificate for the instance EIP (HTTP-01 over webroot /var/lib/cloudalbum/acme),
#           tls local tier: modules.d/tls.env = TLS_MODE=letsencrypt TLS_LE_PROFILE=shortlived TLS_DOMAIN= TLS_PUBLIC_IP=<EIP>
#           TLS_PREVIEW=letsencrypt-ip TLS_FORCE_HTTPS=false (no MODULE_TLS), switch the server.crt / server.key symlinks,
#           nginx -t && reload, enable cloudalbum-tls-renew.timer, restart the application.
#           Failure (rate limit, port 80 unreachable, no ACME client): keep the self-signed certificate, exit 0 with
#           {"preview":"failed","reason":"…"} — the preview falls back to "open in a new tab".
#   off   : only when tls.env carries TLS_PREVIEW=letsencrypt-ip (exit 2 otherwise: a learner's own letsencrypt setup is kept);
#           remove tls.env, switch back to the self-signed certificate, disable the renew timer, delete the certificate.
#   renew : cloudalbum-tls-renew.timer (every 12 hours); renews when less than half of the lifetime is left (ACME client
#           settings per the official documentation).
# The certificate data lives on the data volume (/etc/cloudalbum/tls/letsencrypt) and survives instance replacement.
set -euo pipefail
umask 027

ETC=$(readlink -f /etc/cloudalbum)
TLS=$ETC/tls
LE=$TLS/letsencrypt
TLSENV=$ETC/modules.d/tls.env
WEBROOT=/var/lib/cloudalbum/acme
CERT_NAME=cloudalbum-ip
CLI="runuser -u cloudalbum -- env CLOUDALBUM_ENV_DIR=/etc/cloudalbum CLOUDALBUM_ROLE=cli /usr/bin/node /opt/cloudalbum/backend/dist/cli.js"

out() { printf '%s\n' "$1"; }
[ "$(id -u)" = 0 ] || { out '{"error":{"code":"ROOT_REQUIRED","message":"tls-preview must run as root"}}'; exit 2; }
cmd=${1:-}; shift || true
ip=''
while [ $# -gt 0 ]; do
  case "$1" in
    --ip) ip=${2:-}; shift 2 ;;
    --json) shift ;;
    *) out '{"error":{"code":"USAGE","message":"unknown option"}}'; exit 2 ;;
  esac
done

certbot_args() {
  echo --config-dir "$LE" --work-dir "$WEBROOT/.certbot-work" --logs-dir /var/log/cloudalbum-certbot
}

restart_app() {
  if $CLI check-config >/dev/null; then
    systemctl restart cloudalbum-api cloudalbum-worker
  else
    return 1
  fi
}

case "$cmd" in
  on)
    [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { out '{"error":{"code":"USAGE","message":"--ip <EIPv4> is required"}}'; exit 2; }
    if ! command -v certbot >/dev/null 2>&1; then dnf -y install certbot >/dev/null 2>&1 || true; fi
    if ! command -v certbot >/dev/null 2>&1; then out '{"preview":"failed","reason":"ACME client (certbot) is not available"}'; exit 0; fi
    install -d -m 0750 -o root -g cloudalbum "$LE" "$WEBROOT/.certbot-work"; install -d -m 0750 /var/log/cloudalbum-certbot
    # shellcheck disable=SC2046
    if ! log=$(certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --webroot -w "$WEBROOT" \
                --preferred-profile shortlived --ip-address "$ip" --cert-name "$CERT_NAME" $(certbot_args) 2>&1); then
      reason=$(printf '%s' "$log" | tail -3 | tr -d '"\\' | tr '\n' ' ' | cut -c1-300)
      out "{\"preview\":\"failed\",\"reason\":\"$reason\"}"; exit 0
    fi
    ln -sfn "letsencrypt/live/$CERT_NAME/fullchain.pem" "$TLS/server.crt"
    ln -sfn "letsencrypt/live/$CERT_NAME/privkey.pem" "$TLS/server.key"
    tmp=$(mktemp "$ETC/modules.d/.tls.XXXXXX")
    printf '%s\n' '# written by scripts/module tls-preview on (06 PM-21, platform preview scheme B; tls local tier, no MODULE_TLS)' \
      'TLS_MODE=letsencrypt' 'TLS_LE_PROFILE=shortlived' 'TLS_DOMAIN=' "TLS_PUBLIC_IP=$ip" 'TLS_PREVIEW=letsencrypt-ip' 'TLS_FORCE_HTTPS=false' > "$tmp"
    chown root:cloudalbum "$tmp"; chmod 0640 "$tmp"; mv -f "$tmp" "$TLSENV"
    if ! nginx -t >/dev/null 2>&1 || ! restart_app; then
      rm -f "$TLSENV"; ln -sfn selfsigned.crt "$TLS/server.crt"; ln -sfn selfsigned.key "$TLS/server.key"
      nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
      systemctl restart cloudalbum-api cloudalbum-worker || true
      out '{"preview":"failed","reason":"nginx -t or check-config rejected the certificate"}'; exit 0
    fi
    systemctl reload nginx
    systemctl enable --now cloudalbum-tls-renew.timer >/dev/null 2>&1 || true
    notafter=$(openssl x509 -enddate -noout -in "$TLS/server.crt" | sed 's/^notAfter=//')
    out "{\"preview\":\"issued\",\"ip\":\"$ip\",\"notAfter\":\"$notafter\"}" ;;
  off)
    if [ ! -f "$TLSENV" ] || ! grep -qx 'TLS_PREVIEW=letsencrypt-ip' "$TLSENV"; then
      out '{"error":{"code":"NOT_PREVIEW","message":"tls.env does not come from tls-preview (TLS_PREVIEW=letsencrypt-ip): nothing changed"}}'; exit 2
    fi
    rm -f "$TLSENV"
    ln -sfn selfsigned.crt "$TLS/server.crt"; ln -sfn selfsigned.key "$TLS/server.key"
    systemctl disable --now cloudalbum-tls-renew.timer >/dev/null 2>&1 || true
    if command -v certbot >/dev/null 2>&1; then
      # shellcheck disable=SC2046
      certbot delete --non-interactive --cert-name "$CERT_NAME" $(certbot_args) >/dev/null 2>&1 || true
    fi
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    restart_app || systemctl restart cloudalbum-api cloudalbum-worker
    out '{"preview":"off"}' ;;
  renew)
    [ -f "$TLSENV" ] && grep -qx 'TLS_PREVIEW=letsencrypt-ip' "$TLSENV" || { out '{"renewed":false,"reason":"scheme B is off"}'; exit 0; }
    # shellcheck disable=SC2046
    certbot renew --non-interactive --cert-name "$CERT_NAME" $(certbot_args) --deploy-hook 'nginx -t && systemctl reload nginx'
    out '{"renewed":true}' ;;
  status)
    if [ -f "$TLSENV" ] && grep -qx 'TLS_PREVIEW=letsencrypt-ip' "$TLSENV"; then
      out "{\"preview\":\"on\",\"notAfter\":\"$(openssl x509 -enddate -noout -in "$TLS/server.crt" 2>/dev/null | sed 's/^notAfter=//')\"}"
    else
      out '{"preview":"off"}'
    fi ;;
  *) out '{"error":{"code":"USAGE","message":"tls-preview.sh on --ip <EIP> | off | renew | status"}}'; exit 2 ;;
esac
