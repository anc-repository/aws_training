#!/bin/bash
# cloudalbum platform:apply-env --b64 <base64url(file)> [--restart auto|always|never]   (root; 06 PM-02)
# cloudalbum platform:apply-env --resync                                                  (root; postattach: re-render the slot)
#   1. validate as the cloudalbum user: node cli.js platform:validate-env (PM-01 zod section; failure → exit 2, nothing written)
#   2. write /etc/cloudalbum/platform.env (root:cloudalbum 0640) and the Nginx slot slot-atl-frame-ancestors.inc atomically
#   3. nginx -t && systemctl reload nginx (nginx -t fails → restore the previous files, exit 5)
#   4. processes: restart api / worker (LB_LOCAL_WORKERS=2: rolling) or SIGHUP when only display fields changed
# stdout: {"changed":[…],"action":"none|reload|restart","nginxReloaded":true}
set -euo pipefail
umask 027

CLI_JS=/opt/cloudalbum/backend/dist/cli.js
SLOT=/etc/nginx/cloudalbum.d/slot-atl-frame-ancestors.inc
ETC=$(readlink -f /etc/cloudalbum)
PENV=$ETC/platform.env

fail() { printf '{"error":{"code":"%s","message":"%s"}}\n' "$1" "$2"; exit "$3"; }
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED "platform:apply-env must run as root" 2

b64=''; restart=auto; resync=no
while [ $# -gt 0 ]; do
  case "$1" in
    --b64) b64=${2:-}; shift 2 ;;
    --restart) restart=${2:-}; shift 2 ;;
    --resync) resync=yes; shift ;;
    --json) shift ;;
    *) fail USAGE "unknown option" 2 ;;
  esac
done
[[ $restart =~ ^(auto|always|never)$ ]] || fail USAGE "--restart must be auto|always|never" 2

if [ "$resync" = yes ]; then
  # instance replaced (postattach): platform.env lives on the data volume, the slot on the root volume
  [ -f "$PENV" ] || { printf '{"changed":[],"action":"none","nginxReloaded":false}\n'; exit 0; }
  b64=$(base64 -w0 < "$PENV" | tr '+/' '-_' | tr -d '=')
  restart=never
fi
[[ ${#b64} -ge 1 && ${#b64} -le 8000 && $b64 =~ ^[A-Za-z0-9_-]+=*$ ]] || fail USAGE "--b64 must be base64url" 2

out=$(runuser -u cloudalbum -- env CLOUDALBUM_ENV_DIR=/etc/cloudalbum CLOUDALBUM_ROLE=cli /usr/bin/node "$CLI_JS" \
        platform:validate-env --b64 "$b64" --restart "$restart" --json) || { printf '%s\n' "${out:-}" | tail -1; exit 2; }
valid=$(jq -r .valid <<<"$out")
[ "$valid" = true ] || { printf '%s\n' "$out"; exit 2; }
action=$(jq -r .action <<<"$out")
changed=$(jq -c .changed <<<"$out")

# backups for the rollback
bak=$(mktemp -d /run/cloudalbum-apply-env.XXXXXX)
trap 'rm -rf "$bak"' EXIT
[ -f "$PENV" ] && cp -p "$PENV" "$bak/platform.env"
[ -f "$SLOT" ] && cp -p "$SLOT" "$bak/slot"

write() {  # dest owner mode  (content on stdin)
  local tmp
  tmp=$(mktemp "$(dirname "$1")/.atl.XXXXXX")
  cat > "$tmp"; chown "$2" "$tmp"; chmod "$3" "$tmp"; mv -f "$tmp" "$1"
}
jq -r .file <<<"$out" | write "$PENV" root:cloudalbum 0640
jq -r .slot <<<"$out" | write "$SLOT" root:root 0644

if ! nginx -t >/dev/null 2>&1; then
  if [ -f "$bak/platform.env" ]; then cp -p "$bak/platform.env" "$PENV"; else rm -f "$PENV"; fi
  if [ -f "$bak/slot" ]; then cp -p "$bak/slot" "$SLOT"; else : > "$SLOT"; fi
  fail NGINX_TEST_FAILED "nginx -t rejected the frame-ancestors slot; previous files restored" 5
fi
reloaded=false
if systemctl is-active --quiet nginx; then systemctl reload nginx; reloaded=true; fi

extra=$(systemctl list-units --plain --no-legend --state=active 'cloudalbum-api@*.service' 2>/dev/null | awk '{print $1}')
case "$action" in
  restart)
    systemctl restart cloudalbum-api
    for u in $extra; do systemctl restart "$u"; done          # LB_LOCAL_WORKERS=2: one by one
    systemctl restart cloudalbum-worker ;;
  reload)
    # only ATL_SESSION_ID / ATL_LAB_ID / ATL_VARIANT / ATL_RELEASE changed: the processes reload the Platform section
    # shellcheck disable=SC2086
    systemctl kill --signal=HUP cloudalbum-api cloudalbum-worker $extra ;;
esac
printf '{"changed":%s,"action":"%s","nginxReloaded":%s}\n' "$changed" "$action" "$reloaded"
