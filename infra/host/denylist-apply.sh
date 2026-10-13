#!/bin/bash
# /usr/local/lib/cloudalbum/denylist-apply.sh — owned by ec2 (00-ec2-base.md 6.5).
# Called by cloudalbum-denylist.service (path unit), nginx-reload.sh (--check), nginx.service ExecStartPre (--sync)
# and l0-bootstrap.sh postattach (--sync).
#
# Trust boundary: security/denylist.conf lives in a directory the application user (cloudalbum) can write, so its
# content is untrusted. Nginx never includes it directly: it includes LIVE (/etc/nginx/cloudalbum-denylist.conf,
# root:root 0644), which only this script (root) writes, and only with content that passed the line-by-line check.
# The check runs on a snapshot taken into the root-only /etc/nginx (no window between "validated" and "installed"),
# and LIVE doubles as the last good version (the old security/denylist.conf.last-good was writable by cloudalbum
# and is removed). Only `<IPv4|IPv6>[/prefix] 1;` lines, blank lines and comments are allowed (01#waf).
#
#   (no args)  under denylist.lock: valid -> install as LIVE and reload Nginx; invalid -> keep LIVE, restore
#              security/denylist.conf from LIVE (validated again first), record the rejection, exit 1
#   --check    validate security/denylist.conf only (exit 0 / 1), no reload, no restore
#   --sync     valid -> install as LIVE (no reload); invalid -> keep LIVE (an empty one is created when absent).
#              Always exits 0: nginx.service ExecStartPre uses it so Nginx starts with the last good list.
set -euo pipefail

SEC=/var/lib/cloudalbum/security
FILE=$SEC/denylist.conf
LIVE=/etc/nginx/cloudalbum-denylist.conf
LOCK=$SEC/denylist.lock
LIB=/usr/local/lib/cloudalbum
MAX_BYTES=4194304
MODE=apply
case "${1:-}" in
  --check) MODE=check ;;
  --sync)  MODE=sync ;;
  '')      ;;
  *)       echo "usage: $0 [--check|--sync]" >&2; exit 64 ;;
esac

valid_line() {
  local l=$1
  [[ $l =~ ^[[:space:]]*(#.*)?$ ]] && return 0
  [[ $l =~ ^[[:space:]]*([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?[[:space:]]+1\;[[:space:]]*(#.*)?$ ]] && return 0
  [[ $l =~ ^[[:space:]]*[0-9A-Fa-f]*:[0-9A-Fa-f:]*(/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8]))?[[:space:]]+1\;[[:space:]]*(#.*)?$ ]] && return 0
  return 1
}

count_invalid_file() {   # number of invalid lines of a regular file that root already owns (snapshot / LIVE)
  local f=$1 bad=0 line
  while IFS= read -r line || [ -n "$line" ]; do
    valid_line "$line" || bad=$((bad + 1))
  done < "$f"
  echo "$bad"
}

# snapshot <dest>: copy FILE into a root-only temporary file. Returns 1 (= invalid as a whole) when FILE is a symlink,
# not a regular file, unreadable or larger than MAX_BYTES; `timeout` bounds a FIFO swapped in after the checks.
snapshot() {
  [ ! -L "$FILE" ] && [ -f "$FILE" ] || return 1
  timeout 5 head -c $((MAX_BYTES + 1)) -- "$FILE" > "$1" 2>/dev/null || return 1
  [ "$(stat -c %s "$1")" -le "$MAX_BYTES" ]
}

new_tmp() { mktemp /etc/nginx/.cloudalbum-denylist.XXXXXX; }

promote() {   # promote <validated root-owned temp>: atomically becomes LIVE
  chown root:root "$1"; chmod 0644 "$1"
  mv -fT "$1" "$LIVE"
}

ensure_live() {   # nginx -t needs the include target even before the first successful sync
  [ -f "$LIVE" ] && [ ! -L "$LIVE" ] && return 0
  rm -f "$LIVE"
  local t; t=$(new_tmp); promote "$t"
}

# check_snapshot <temp>: prints the number of invalid lines (1 when FILE could not be snapshotted); 0 = valid.
# A missing FILE counts as an empty, valid list.
check_snapshot() {
  if [ ! -e "$FILE" ] && [ ! -L "$FILE" ]; then : > "$1"; echo 0; return; fi
  if ! snapshot "$1"; then echo 1; return; fi
  count_invalid_file "$1"
}

rm -f "$SEC/denylist.conf.last-good" 2>/dev/null || true   # legacy copy in the application-writable directory
[ -L "$LOCK" ] && rm -f "$LOCK"                               # root opens the lock file: never through a planted link

if [ "$MODE" = check ]; then
  tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
  bad=$(check_snapshot "$tmp")
  [ "$bad" -eq 0 ] || { echo "denylist.conf: $bad invalid line(s)" >&2; exit 1; }
  exit 0
fi

ensure_live
if [ "$MODE" = sync ]; then
  [ -d "$SEC" ] || exit 0
  exec 9>>"$LOCK"
  flock -w 10 9 || { echo "denylist.lock busy: keeping $LIVE" >&2; exit 0; }
  [ -e "$FILE" ] || [ -L "$FILE" ] || exit 0                      # nothing written yet: keep LIVE
  tmp=$(new_tmp); trap 'rm -f "$tmp"' EXIT
  bad=$(check_snapshot "$tmp")
  if [ "$bad" -eq 0 ]; then
    promote "$tmp"
  else
    logger -t cloudalbum-denylist "{\"event\":\"denylist.rejected\",\"invalidLines\":$bad,\"phase\":\"sync\"}" || true
    echo "denylist.conf: $bad invalid line(s), keeping $LIVE" >&2
  fi
  exit 0
fi

[ -d "$SEC" ] || { echo "security directory missing (data volume not mounted?)" >&2; exit 1; }
exec 9>>"$LOCK"
flock -w 10 9
tmp=$(new_tmp); trap 'rm -f "$tmp" "${restore:-}"' EXIT

bad=$(check_snapshot "$tmp")
if [ "$bad" -ne 0 ]; then
  logger -t cloudalbum-denylist "{\"event\":\"denylist.rejected\",\"invalidLines\":$bad}"
  # give the application back the list Nginx actually uses (LIVE, written by root after validation; validated again)
  restore=$(mktemp "$SEC/.denylist.restore.XXXXXX")
  if [ "$(count_invalid_file "$LIVE")" -eq 0 ]; then cat -- "$LIVE" > "$restore"; else : > "$restore"; fi
  chown cloudalbum:cloudalbum "$restore"; chmod 0640 "$restore"
  if [ -d "$FILE" ] && [ ! -L "$FILE" ]; then rm -rf -- "$FILE"; fi
  mv -fT "$restore" "$FILE"
  "$LIB/nginx-reload.sh" --record-rejected "$bad" || true
  exit 1
fi

promote "$tmp"
"$LIB/nginx-reload.sh" --skip-denylist-check
