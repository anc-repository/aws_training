#!/bin/bash
# cloudalbum probe-token --init | --rotate   (root; 06 PM-09, PM-13)
#   The local probe secret: one line "atlpk1.<base64url of 32 random bytes>" in ATL_PROBE_TOKEN_FILE
#   (default /etc/cloudalbum/atl/probe.token, on the data volume; directory root:cloudalbum 0750, file root:cloudalbum 0640).
#   --init   create it when missing (idempotent)       --rotate   regenerate it (every one-time token and lab-token becomes invalid)
# The value is never printed: stdout {"present":true,"fingerprint":"sha256:<12 hex>","created":true|false}
set -euo pipefail
umask 027

fail() { printf '{"error":{"code":"%s","message":"%s"}}\n' "$1" "$2"; exit "$3"; }
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED "probe-token --init/--rotate must run as root" 2

mode=''
for a in "$@"; do
  case "$a" in
    --init) mode=init ;;
    --rotate) mode=rotate ;;
    --json) ;;
    *) fail USAGE "unknown option" 2 ;;
  esac
done
[ -n "$mode" ] || fail USAGE "--init or --rotate" 2

ETC=$(readlink -f /etc/cloudalbum)
file=/etc/cloudalbum/atl/probe.token
if [ -f "$ETC/platform.env" ]; then
  v=$(sed -n 's/^ATL_PROBE_TOKEN_FILE=//p' "$ETC/platform.env" | tail -1)
  if [ -n "$v" ]; then
    [[ $v =~ ^/etc/cloudalbum/atl/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || fail CONFIG_INVALID "ATL_PROBE_TOKEN_FILE must be under /etc/cloudalbum/atl/" 2
    file=$v
  fi
fi
real="$ETC/${file#/etc/cloudalbum/}"
install -d -o root -g cloudalbum -m 0750 "$ETC/atl" "$(dirname "$real")"

fingerprint() { printf 'sha256:%s' "$(printf '%s' "$1" | sha256sum | cut -c1-12)"; }

current=''
if [ -f "$real" ]; then current=$(head -1 "$real" | tr -d '\r\n'); fi
if [ "$mode" = init ] && [[ $current =~ ^atlpk1\.[A-Za-z0-9_-]{43}$ ]]; then
  printf '{"present":true,"fingerprint":"%s","created":false}\n' "$(fingerprint "$current")"
  exit 0
fi

secret="atlpk1.$(head -c 32 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=')"
tmp=$(mktemp "$(dirname "$real")/.probe.XXXXXX")
printf '%s\n' "$secret" > "$tmp"
chown root:cloudalbum "$tmp"; chmod 0640 "$tmp"; mv -f "$tmp" "$real"
printf '{"present":true,"fingerprint":"%s","created":true}\n' "$(fingerprint "$secret")"
