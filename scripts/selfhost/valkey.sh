#!/bin/bash
# scripts/selfhost/valkey.sh apply|revert — cache local tier: Valkey (or Redis 6 on older AL2023) self-hosted on the EC2
# (registry cache.selfHosted.installer; `scripts/module enable cache --self-hosted`). Root only, idempotent.
#   - binds 127.0.0.1 only, protected mode, no persistence (a cache has no authoritative data), LRU with a memory cap
#   - the application uses CACHE_DRIVER=redis + REDIS_URL=redis://127.0.0.1:6379 + REDIS_TLS=off
#     (selfHosted.match REDIS_URL=loopback: no MODULE_CACHE=on, CFG-004 exempt)
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "valkey.sh must run as root" >&2; exit 1; }

MAXMEM=${CLOUDALBUM_VALKEY_MAXMEMORY:-128mb}
action=${1:-apply}

pick() {   # -> "<package> <service> <config file>"
  if rpm -q valkey >/dev/null 2>&1 || dnf -q list --available valkey >/dev/null 2>&1; then
    echo "valkey valkey /etc/valkey/valkey.conf"
  else
    echo "redis6 redis6 /etc/redis6/redis6.conf"
  fi
}

read -r pkg svc conf <<< "$(pick)"
case "$action" in
  apply)
    rpm -q "$pkg" >/dev/null 2>&1 || dnf -y install "$pkg"
    marker="# --- cloudalbum (scripts/selfhost/valkey.sh) ---"
    if ! grep -qF "$marker" "$conf"; then
      cp -p "$conf" "$conf.cloudalbum.bak"
      printf '\n%s\n%s\n' "$marker" "include $(dirname "$conf")/cloudalbum.conf" >> "$conf"
    fi
    printf '%s\n' "$marker" 'bind 127.0.0.1 -::1' 'port 6379' 'protected-mode yes' 'save ""' 'appendonly no' \
      "maxmemory $MAXMEM" 'maxmemory-policy allkeys-lru' > "$(dirname "$conf")/cloudalbum.conf"
    chmod 0640 "$(dirname "$conf")/cloudalbum.conf"
    chgrp "$svc" "$(dirname "$conf")/cloudalbum.conf" 2>/dev/null || true
    systemctl enable "$svc"
    systemctl restart "$svc"
    echo "valkey.sh: $svc listening on 127.0.0.1:6379 (maxmemory $MAXMEM, no persistence)" ;;
  revert)
    systemctl disable --now "$svc" 2>/dev/null || true
    echo "valkey.sh: $svc stopped" ;;
  *)
    echo "usage: $0 apply|revert" >&2; exit 64 ;;
esac
