#!/bin/bash
# /usr/local/lib/cloudalbum/denylist-apply.sh — owned by ec2 (00-ec2-base.md 6.5).
# Called by cloudalbum-denylist.service (path unit) and by nginx-reload.sh (--check).
#   (no args)  validate security/denylist.conf line by line under denylist.lock; valid -> save as last-good and reload
#              Nginx; invalid -> restore last-good, record the rejection (snapshot + journal), exit 1
#   --check    validate only (exit 0 / 1), no reload, no restore
# Only `<IPv4|IPv6>[/prefix] 1;` lines, blank lines and comments are allowed (01#waf).
set -euo pipefail

SEC=/var/lib/cloudalbum/security
FILE=$SEC/denylist.conf
GOOD=$SEC/denylist.conf.last-good
LOCK=$SEC/denylist.lock
LIB=/usr/local/lib/cloudalbum
MODE=apply
[ "${1:-}" = --check ] && MODE=check

valid_line() {
  local l=$1
  [[ $l =~ ^[[:space:]]*(#.*)?$ ]] && return 0
  [[ $l =~ ^[[:space:]]*([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?[[:space:]]+1\;[[:space:]]*(#.*)?$ ]] && return 0
  [[ $l =~ ^[[:space:]]*[0-9A-Fa-f]*:[0-9A-Fa-f:]*(/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8]))?[[:space:]]+1\;[[:space:]]*(#.*)?$ ]] && return 0
  return 1
}

count_invalid() {
  local f=$1 bad=0 line
  [ -f "$f" ] || { echo 0; return; }
  while IFS= read -r line || [ -n "$line" ]; do
    valid_line "$line" || bad=$((bad + 1))
  done < "$f"
  echo "$bad"
}

if [ "$MODE" = check ]; then
  bad=$(count_invalid "$FILE")
  [ "$bad" -eq 0 ] || { echo "denylist.conf: $bad invalid line(s)" >&2; exit 1; }
  exit 0
fi

[ -d "$SEC" ] || { echo "security directory missing (data volume not mounted?)" >&2; exit 1; }
exec 9>>"$LOCK"
flock -w 10 9

bad=$(count_invalid "$FILE")
if [ "$bad" -ne 0 ]; then
  logger -t cloudalbum-denylist "{\"event\":\"denylist.rejected\",\"invalidLines\":$bad}"
  if [ -f "$GOOD" ]; then cp -p "$GOOD" "$FILE.restore" && mv -f "$FILE.restore" "$FILE"
  else : > "$FILE"; fi
  "$LIB/nginx-reload.sh" --record-rejected "$bad" || true
  exit 1
fi

cp -p "$FILE" "$GOOD.tmp" && mv -f "$GOOD.tmp" "$GOOD"
"$LIB/nginx-reload.sh" --skip-denylist-check
