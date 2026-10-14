#!/bin/bash
# infra/modules/dns/host-setup.sh apply|revert|status — dns hostSetup (registry; 00-ec2-base.md 6.9; 01#dns sections 3, 6).
# Root, idempotent, depends only on "release + modules.d/dns.env" (replay contract E12). Route 53 itself needs nothing on
# the instance; this script only guards the one Nginx fragment of the module:
#   apply : run-hostsetup.sh has already rendered cloudalbum.server.d/dns-canonical.conf from the template. The values are
#           pasted into nginx syntax, so they are validated here (record name = lower-case host name, APP_BASE_URL =
#           http(s)://<host>); invalid values remove the fragment and fail (run-hostsetup.sh restores the previous fragments).
#           Writes /var/lib/cloudalbum/dns/state.json (record name, canonical redirect on/off) for /lab and the checks.
#   revert: remove the fragment and the state file (run-hostsetup.sh removes the fragment as well).
#   status: print the state as JSON.
set -euo pipefail

FRAG=/etc/nginx/cloudalbum.server.d/dns-canonical.conf
ENV_FILE=${CLOUDALBUM_MODULE_ENV:-/etc/cloudalbum/modules.d/dns.env}
STATE_DIR=/var/lib/cloudalbum/dns
STATE=$STATE_DIR/state.json
HOST_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$'
action=${1:-apply}

env_value() {   # env_value <KEY> -> value from modules.d/dns.env (no shell evaluation)
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed -e 's/[[:space:]]#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

case "$action" in
  apply)
    provider=$(env_value DNS_PROVIDER)
    record=$(env_value DNS_RECORD_NAME)
    base=$(env_value APP_BASE_URL)
    canonical=$(env_value DNS_CANONICAL_REDIRECT)
    canonical=${canonical:-off}
    if [ -z "$record" ] && [[ $base =~ ^https?://([^/:]+) ]]; then record=${BASH_REMATCH[1]}; fi
    case "$canonical" in on|off) ;; *) echo "dns host-setup: DNS_CANONICAL_REDIRECT must be on|off (got $canonical)" >&2; rm -f "$FRAG"; exit 1 ;; esac
    if [ "$canonical" = on ]; then
      if ! [[ $record =~ $HOST_RE ]]; then echo "dns host-setup: DNS_RECORD_NAME is not a host name: $record" >&2; rm -f "$FRAG"; exit 1; fi
      if ! [[ $base =~ ^https?://[a-z0-9.-]+$ ]]; then echo "dns host-setup: APP_BASE_URL must be http(s)://<host>: $base" >&2; rm -f "$FRAG"; exit 1; fi
    fi
    install -d -m 0755 "$STATE_DIR"
    tmp=$(mktemp "$STATE_DIR/.state.XXXXXX")
    jq -n --arg provider "${provider:-none}" --arg record "$record" --arg base "$base" --arg canonical "$canonical" \
      --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{provider: $provider, recordName: $record, appBaseUrl: $base, canonicalRedirect: $canonical, appliedAt: $at}' > "$tmp"
    chmod 0644 "$tmp"; mv -f "$tmp" "$STATE" ;;
  revert)
    rm -f "$FRAG" "$STATE" ;;
  status)
    if [ -f "$STATE" ]; then cat "$STATE"; else echo '{"provider":"none"}'; fi ;;
  *)
    echo "usage: $0 apply|revert|status" >&2; exit 64 ;;
esac
