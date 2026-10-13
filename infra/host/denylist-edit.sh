#!/bin/bash
# /usr/local/lib/cloudalbum/denylist-edit.sh — owned by ec2. Used by the fail2ban action cloudalbum-denylist.
#   denylist-edit.sh add <ip> [comment]   append "<ip> 1; # <comment>" (idempotent)
#   denylist-edit.sh remove <ip>          remove every line for <ip>
# Writes with "temporary file + rename" under security/denylist.lock (same protocol as BlocklistPort(nginx));
# the path unit then validates the file and reloads Nginx.
set -euo pipefail

SEC=/var/lib/cloudalbum/security
FILE=$SEC/denylist.conf
LOCK=$SEC/denylist.lock
op=${1:-}; ip=${2:-}; comment=${3:-}

[[ $ip =~ ^[0-9A-Fa-f.:/]+$ ]] || { echo "usage: $0 add|remove <ip> [comment]" >&2; exit 64; }
comment=${comment//[^A-Za-z0-9_.:-]/_}

exec 9>>"$LOCK"
flock -w 10 9
touch "$FILE"
tmp=$(mktemp "$SEC/.denylist.XXXXXX")
grep -v -E "^[[:space:]]*${ip//./\\.}[[:space:]]+1;" "$FILE" > "$tmp" || true
case "$op" in
  add)    printf '%s 1;%s\n' "$ip" "${comment:+ # $comment}" >> "$tmp" ;;
  remove) ;;
  *)      rm -f "$tmp"; echo "usage: $0 add|remove <ip> [comment]" >&2; exit 64 ;;
esac
chown cloudalbum:cloudalbum "$tmp"
chmod 0640 "$tmp"
mv -f "$tmp" "$FILE"
