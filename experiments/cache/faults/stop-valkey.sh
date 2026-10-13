#!/bin/bash
# cache/fail-open（selfhost 档）：停掉本机自建 Valkey，观察 fail-open（请求照常成功，路径头 cache=redis@local:error-bypass）
# 经投递通道以 root 执行：ssh … sudo bash -s < stop-valkey.sh，或 SSM AWS-RunShellScript。
set -euo pipefail
unit=""
for svc in valkey valkey-server redis6 redis; do
  if systemctl list-unit-files "${svc}.service" --no-legend 2>/dev/null | grep -q "^${svc}\.service"; then unit="$svc"; break; fi
done
if [[ -z "$unit" ]]; then
  echo "没有找到本机 Valkey / Redis 的 systemd 单元（先 scripts/module enable cache --self-hosted）" >&2
  exit 2
fi
systemctl stop "$unit"
echo "stopped $unit at $(date -u +%FT%TZ)"
