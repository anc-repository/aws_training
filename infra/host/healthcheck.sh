#!/bin/bash
# /usr/local/lib/cloudalbum/healthcheck.sh — run every 30 s by cloudalbum-healthcheck.timer (00-ec2-base.md 6.8).
# For cloudalbum-api (127.0.0.1:3000) and every active cloudalbum-api@<port>: GET /api/health/live (3 s).
# On failure:
#   - the unit stopped with exit status 78 (configuration rejected): never restart, only log
#   - more than 3 restarts in the last 5 minutes: stop intervening (systemd StartLimit and the operator take over)
#   - otherwise restart the unit and log a structured healthcheck.restart line (journal + logs/healthcheck.jsonl)
set -uo pipefail

STATE_DIR=/run/cloudalbum-healthcheck
LOG=/var/lib/cloudalbum/logs/healthcheck.jsonl
mkdir -p "$STATE_DIR"

emit() {   # emit <json>
  logger -t cloudalbum-healthcheck "$1"
  if [ -d "$(dirname "$LOG")" ]; then echo "$1" >> "$LOG" 2>/dev/null || true; fi
}

check_unit() {   # check_unit <unit> <port>
  local unit=$1 port=$2 now status recent=0 ts f
  if curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:$port/api/health/live"; then return 0; fi
  now=$(date +%s)
  status=$(systemctl show -p ExecMainStatus --value "$unit" 2>/dev/null || echo "")
  if [ "$status" = 78 ]; then
    emit "{\"event\":\"healthcheck.config-error\",\"unit\":\"$unit\",\"at\":$now}"
    return 0
  fi
  f="$STATE_DIR/${unit//[^A-Za-z0-9@._-]/_}.restarts"
  touch "$f"
  while read -r ts; do
    [ -n "$ts" ] && [ $((now - ts)) -lt 300 ] && recent=$((recent + 1))
  done < "$f"
  if [ "$recent" -ge 3 ]; then
    emit "{\"event\":\"healthcheck.gave-up\",\"unit\":\"$unit\",\"restarts5m\":$recent,\"at\":$now}"
    return 0
  fi
  systemctl restart "$unit"
  { awk -v now="$now" 'now - $1 < 300' "$f"; echo "$now"; } > "$f.tmp" && mv -f "$f.tmp" "$f"
  emit "{\"event\":\"healthcheck.restart\",\"unit\":\"$unit\",\"port\":$port,\"at\":$now}"
}

if systemctl is-enabled --quiet cloudalbum-api 2>/dev/null; then
  check_unit cloudalbum-api.service 3000
fi
while read -r unit _; do
  [ -n "$unit" ] || continue
  port=${unit#cloudalbum-api@}; port=${port%.service}
  [[ $port =~ ^[0-9]+$ ]] && check_unit "$unit" "$port"
done < <(systemctl list-units --plain --no-legend --state=active,activating,failed 'cloudalbum-api@*.service' 2>/dev/null)
exit 0
