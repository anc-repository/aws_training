#!/bin/bash
# scripts/selfhost/postgres.sh apply|revert — database local tier: PostgreSQL 16 self-hosted on the EC2
# (registry database.selfHosted.installer; `scripts/module enable database --self-hosted`). Root only, idempotent.
#   - packages postgresql16-server (AL2023); data directory ON THE DATA VOLUME: /var/lib/cloudalbum/pgsql/data
#     (survives instance replacement like everything else under /var/lib/cloudalbum); postgres joins group cloudalbum
#     to traverse the 0750 volume root
#   - listens on 127.0.0.1 only; scram-sha-256; role + database "cloudalbum" with the password of secrets.env DB_PASSWORD
#     (logical name db-password, written by scripts/module before this script runs)
#   - the application then uses DB_DRIVER=postgres + DB_HOST=127.0.0.1 (selfHosted.match: no MODULE_DATABASE=on, CFG-004)
# revert only stops / disables the server; the data directory is kept (remove it by hand after `disable` verified the copy).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "postgres.sh must run as root" >&2; exit 1; }

PGDATA=/var/lib/cloudalbum/pgsql/data
DROPIN=/etc/systemd/system/postgresql.service.d/50-cloudalbum.conf
SECRETS=/etc/cloudalbum/secrets.env
action=${1:-apply}

secret() { sed -n "s/^$1=//p" "$SECRETS" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"; }

case "$action" in
  apply)
    mountpoint -q /var/lib/cloudalbum || { echo "data volume not mounted" >&2; exit 1; }
    rpm -q postgresql16-server >/dev/null 2>&1 || dnf -y install postgresql16-server postgresql16
    usermod -aG cloudalbum postgres
    install -d -o postgres -g postgres -m 0700 /var/lib/cloudalbum/pgsql "$PGDATA"
    install -d -m 0755 "$(dirname "$DROPIN")"
    printf '%s\n' '# cloudalbum database local tier (scripts/selfhost/postgres.sh)' '[Unit]' \
      'RequiresMountsFor=/var/lib/cloudalbum' '[Service]' "Environment=PGDATA=$PGDATA" > "$DROPIN"
    systemctl daemon-reload
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      runuser -u postgres -- initdb -D "$PGDATA" --auth-local=peer --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8
    fi
    conf=$PGDATA/postgresql.auto.conf
    grep -q "^listen_addresses" "$conf" 2>/dev/null || echo "listen_addresses = '127.0.0.1'" >> "$conf"
    grep -q "^password_encryption" "$conf" 2>/dev/null || echo "password_encryption = 'scram-sha-256'" >> "$conf"
    hba=$PGDATA/pg_hba.conf
    grep -q '^host[[:space:]]\+cloudalbum[[:space:]]\+cloudalbum[[:space:]]\+127.0.0.1/32' "$hba" || \
      echo 'host cloudalbum cloudalbum 127.0.0.1/32 scram-sha-256' >> "$hba"
    systemctl enable --now postgresql
    pw=$(secret DB_PASSWORD)
    [ -n "$pw" ] || { echo "DB_PASSWORD missing in $SECRETS (scripts/module writes it first)" >&2; exit 1; }
    [[ $pw =~ ^[A-Za-z0-9_-]+$ ]] || { echo "DB_PASSWORD must be URL-safe base64" >&2; exit 1; }
    runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudalbum') THEN CREATE ROLE cloudalbum LOGIN; END IF;
END \$\$;
ALTER ROLE cloudalbum WITH LOGIN PASSWORD '$pw';
SQL
    if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'cloudalbum'" | grep -q 1; then
      runuser -u postgres -- createdb -O cloudalbum cloudalbum
    fi
    echo "postgres.sh: PostgreSQL 16 ready on 127.0.0.1:5432 (data in $PGDATA)" ;;
  revert)
    systemctl disable --now postgresql 2>/dev/null || true
    echo "postgres.sh: server stopped; data kept in $PGDATA" ;;
  *)
    echo "usage: $0 apply|revert" >&2; exit 64 ;;
esac
