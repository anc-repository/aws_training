#!/bin/bash
# cache/fail-open（selfhost 档）：恢复本机自建 Valkey；cache 探针随后从 degraded 回到 ok
set -euo pipefail
unit=""
for svc in valkey valkey-server redis6 redis; do
  if systemctl list-unit-files "${svc}.service" --no-legend 2>/dev/null | grep -q "^${svc}\.service"; then unit="$svc"; break; fi
done
if [[ -z "$unit" ]]; then
  echo "没有找到本机 Valkey / Redis 的 systemd 单元" >&2
  exit 2
fi
systemctl start "$unit"
echo "started $unit at $(date -u +%FT%TZ)"
