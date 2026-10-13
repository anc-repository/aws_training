#!/bin/bash
# scripts/selfhost/pgbouncer.sh apply|revert — db-proxy local tier (DB_PROXY_MODE=pgbouncer, needs DB_DRIVER=postgres).
# Used as the db-proxy hostSetup (registry) and therefore replayed by run-hostsetup.sh. Root only, idempotent.
#   - unit cloudalbum-pgbouncer.service (module host units are named cloudalbum-<id>-*; 00-ec2-base.md 6.8)
#   - listens on 127.0.0.1:6432, pool_mode from DB_PROXY_POOL_MODE (transaction by default), upstream DB_HOST:DB_PORT
#   - userlist.txt is a derived copy of secrets.env DB_PASSWORD (D5 exception): rendered into /run (tmpfs), 0600
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "pgbouncer.sh must run as root" >&2; exit 1; }

ENV_DIR=/etc/cloudalbum
RUNDIR=/run/cloudalbum-pgbouncer
CONF=/etc/pgbouncer/cloudalbum.ini
UNIT=/etc/systemd/system/cloudalbum-pgbouncer.service
action=${1:-apply}

env_get() {   # env_get <KEY> <default>
  local v="" f x
  for f in "$ENV_DIR/cloudalbum.env" "$ENV_DIR"/modules.d/*.env; do
    [ -f "$f" ] || continue
    x=$(sed -n "s/^$1=//p" "$f" | tail -1 | sed -e 's/[[:space:]]#.*$//' -e 's/^"\(.*\)"$/\1/')
    [ -n "$x" ] && v=$x
  done
  echo "${v:-$2}"
}

case "$action" in
  apply)
    rpm -q pgbouncer >/dev/null 2>&1 || dnf -y install pgbouncer
    host=$(env_get DB_HOST 127.0.0.1); port=$(env_get DB_PORT 5432)
    db=$(env_get DB_NAME cloudalbum); user=$(env_get DB_USER cloudalbum)
    mode=$(env_get DB_PROXY_POOL_MODE transaction)
    pw=$(sed -n 's/^DB_PASSWORD=//p' "$ENV_DIR/secrets.env" | tail -1)
    [ -n "$pw" ] || { echo "DB_PASSWORD missing in secrets.env" >&2; exit 1; }
    install -d -m 0755 /etc/pgbouncer
    printf '%s\n' '; cloudalbum db-proxy local tier (scripts/selfhost/pgbouncer.sh)' '[databases]' \
      "$db = host=$host port=$port dbname=$db" '[pgbouncer]' 'listen_addr = 127.0.0.1' 'listen_port = 6432' \
      'auth_type = scram-sha-256' "auth_file = $RUNDIR/userlist.txt" "pool_mode = $mode" \
      'max_client_conn = 200' 'default_pool_size = 10' 'server_tls_sslmode = prefer' \
      "unix_socket_dir = $RUNDIR" > "$CONF"
    chmod 0644 "$CONF"
    cat > "$UNIT" <<EOF
# owned by db-proxy local tier (scripts/selfhost/pgbouncer.sh)
[Unit]
Description=CloudAlbum db-proxy local tier (PgBouncer on 127.0.0.1:6432)
After=network-online.target postgresql.service

[Service]
Type=simple
User=pgbouncer
RuntimeDirectory=cloudalbum-pgbouncer
RuntimeDirectoryMode=0700
ExecStartPre=+/bin/bash /opt/cloudalbum/scripts/selfhost/pgbouncer.sh render-userlist
ExecStart=/usr/bin/pgbouncer $CONF
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable cloudalbum-pgbouncer
    systemctl restart cloudalbum-pgbouncer
    unset pw ;;
  render-userlist)
    user=$(env_get DB_USER cloudalbum)
    pw=$(sed -n 's/^DB_PASSWORD=//p' "$ENV_DIR/secrets.env" | tail -1)
    install -d -o pgbouncer -g pgbouncer -m 0700 "$RUNDIR"
    ( umask 077; printf '"%s" "%s"\n' "$user" "$pw" > "$RUNDIR/userlist.txt" )
    chown pgbouncer:pgbouncer "$RUNDIR/userlist.txt" ;;
  revert)
    systemctl disable --now cloudalbum-pgbouncer 2>/dev/null || true
    rm -f "$UNIT" "$CONF"
    rm -rf "$RUNDIR"
    systemctl daemon-reload ;;
  *)
    echo "usage: $0 apply|revert" >&2; exit 64 ;;
esac
