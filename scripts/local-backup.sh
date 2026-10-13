#!/bin/bash
# scripts/local-backup.sh — run by cloudalbum-backup.service (user cloudalbum, daily 03:30 Asia/Tokyo).
# The backup module's control group (BACKUP_MODE=local): backups live on the SAME volume as the data on purpose.
#   - DB_DRIVER=sqlite                      : sqlite3 .backup (online, consistent) + PRAGMA integrity_check + gzip
#   - DB_DRIVER=postgres on loopback (self) : pg_dump --format=custom (password from secrets.env DB_PASSWORD)
#   - DB_DRIVER=postgres on RDS             : skipped (automated backups / PITR are RDS features)
#   - uploads manifest (key, size, mtime) for later verification
# Keeps 7 days. Result in backup/last-run.json (read by the ec2 detector check "timers": > 26 h without success = degraded).
set -euo pipefail

ENV_DIR=${CLOUDALBUM_ENV_DIR:-/etc/cloudalbum}
DATA=${CLOUDALBUM_DATA_DIR:-/var/lib/cloudalbum}
B=$DATA/backup
KEEP_DAYS=${BACKUP_KEEP_DAYS:-7}
ts=$(date -u +%Y%m%dT%H%M%SZ)
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)

env_get() {   # env_get <KEY> <default> : last value across cloudalbum.env and modules.d/*.env (no shell evaluation)
  local v="" f x
  for f in "$ENV_DIR/cloudalbum.env" "$ENV_DIR"/modules.d/*.env; do
    [ -f "$f" ] || continue
    x=$(sed -n "s/^$1=//p" "$f" | tail -1 | sed -e 's/[[:space:]]#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")
    [ -n "$x" ] && v=$x
  done
  echo "${v:-$2}"
}
secret_get() {
  [ -r "$ENV_DIR/secrets.env" ] || return 0
  sed -n "s/^$1=//p" "$ENV_DIR/secrets.env" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

install -d -m 0750 "$B/sqlite" "$B/postgres" "$B/uploads"

driver=$(env_get DB_DRIVER sqlite)
file=""; bytes=0; integrity="skipped"; note=""
case "$driver" in
  sqlite)
    db=$(env_get SQLITE_PATH "$DATA/db/cloudalbum.sqlite")
    if [ -f "$db" ]; then
      tmp="$B/sqlite/.cloudalbum-$ts.sqlite"
      sqlite3 "$db" ".timeout 5000" ".backup '$tmp'"
      integrity=$(sqlite3 "$tmp" 'PRAGMA integrity_check;' | head -1)
      gzip -6 "$tmp"
      file="$B/sqlite/cloudalbum-$ts.sqlite.gz"
      mv -f "$tmp.gz" "$file"
    else
      note="no database file yet"
    fi ;;
  postgres)
    host=$(env_get DB_HOST "")
    case "$host" in
      127.*|localhost|::1)
        file="$B/postgres/cloudalbum-$ts.dump"
        PGPASSWORD=$(secret_get DB_PASSWORD) pg_dump --format=custom --no-owner \
          -h "$host" -p "$(env_get DB_PORT 5432)" -U "$(env_get DB_USER cloudalbum)" \
          -d "$(env_get DB_NAME cloudalbum)" -f "$file"
        integrity=ok ;;
      *) note="RDS: automated backups and PITR are managed by Amazon RDS" ;;
    esac ;;
esac
[ -n "$file" ] && bytes=$(stat -c %s "$file")

manifest="$B/uploads/manifest-$ts.txt"
entries=0
if [ -d "$DATA/uploads" ]; then
  find "$DATA/uploads" -type f -not -path '*/.incoming/*' -printf '%P\t%s\t%T@\n' | sort > "$manifest"
  entries=$(wc -l < "$manifest")
fi

find "$B/sqlite" "$B/postgres" "$B/uploads" -type f -mtime +"$KEEP_DAYS" -delete

ok=true
[ "$integrity" = ok ] || [ "$integrity" = skipped ] || ok=false
jq -n --arg at "$started" --arg driver "$driver" --arg file "$file" --argjson bytes "$bytes" \
      --arg integrity "$integrity" --arg manifest "$manifest" --argjson entries "$entries" \
      --argjson ok "$ok" --arg note "$note" --argjson keep "$KEEP_DAYS" \
  '{at: $at, ok: $ok, driver: $driver, file: $file, bytes: $bytes, integrity_check: $integrity,
    uploadsManifest: $manifest, uploadsEntries: $entries, keepDays: $keep, note: $note, location: "same-volume"}' \
  > "$B/.last-run.json"
mv -f "$B/.last-run.json" "$B/last-run.json"
$ok || { echo "local-backup: integrity_check=$integrity" >&2; exit 1; }
echo "local-backup: $driver ok ($file, $bytes bytes; manifest $entries entries)"
