#!/bin/bash
# /usr/local/lib/cloudalbum/nginx-reload.sh — the single entry point for every Nginx reload (scripts/module,
# certbot deploy hook, run-hostsetup.sh, denylist-apply.sh). Owned by ec2 (00-ec2-base.md 6.5).
#   nginx-reload.sh                          denylist --check, nginx -t, reload (only when nginx is active)
#   nginx-reload.sh --skip-denylist-check    same without the deny-list validation (called by denylist-apply.sh)
#   nginx-reload.sh --record-rejected <n>    only record a rejected deny list (n invalid lines; last-good kept)
# Records the outcome in security/nginx-state.json (read by security-snapshot.sh -> ec2 check "nginx").
# Rolling back fragments on failure is the caller's job (run-hostsetup.sh keeps a copy of the fragment directories).
set -euo pipefail

SEC=/var/lib/cloudalbum/security
STATE=$SEC/nginx-state.json
LIB=/usr/local/lib/cloudalbum

record() {   # record <ok:true|false> [rejectedLines]
  [ -d "$SEC" ] || return 0
  local tmp prev='{}'
  [ -s "$STATE" ] && prev=$(cat "$STATE")
  tmp=$(mktemp "$SEC/.nginx-state.XXXXXX")
  jq --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson ok "$1" --arg rej "${2:-}" '
      . + (if $rej == "" then {lastReloadAt: $at, lastReloadOk: $ok, denylistRejectedLines: 0}
           else {denylistRejectedLines: ($rej | tonumber), lastRejectedAt: $at, lastRejectedLines: ($rej | tonumber)} end)
    ' <<< "$prev" > "$tmp"
  chown root:cloudalbum "$tmp" && chmod 0640 "$tmp" && mv -f "$tmp" "$STATE"
}

case "${1:-}" in
  --record-rejected) record false "${2:-0}"; exit 0 ;;
  --skip-denylist-check) ;;
  *) if ! "$LIB/denylist-apply.sh" --check; then record false; exit 1; fi ;;
esac

if ! nginx -t -q; then
  nginx -t || true
  record false
  exit 1
fi
if systemctl is-active --quiet nginx; then
  systemctl reload nginx
fi
record true
