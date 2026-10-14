#!/bin/bash
# monitoring/kill-test 的“停实例”阶段（05#monitoring 第 5 节步骤 2；06 PM-M30）：在运维机 / 工作台上以调用者凭证（AWS CLI）
# 停止实验机、保持 <instanceDownSec> 秒、启动，并等实例 running、管理通道（SSM PingStatus=Online）恢复。EIP 与实例 ID 不变。
#   bash stop-instance.sh <phase> <downSec> <instanceDownSec> [<instanceId>]        （runner：faults[].via=local）
# phase=service 时什么也不做；phase=all 时先等服务阶段结束（downSec + 120 秒）再停。
# 实例 ID：参数，或 EXP_INSTANCE_ID，或仓库 .cloudalbum/state.json 的 base.instanceId，或平台模式下按标签发现
#   （tag:atl:env-id = ATL_ENV_ID（/etc/atl/session.env）且 tag:atl:role = lab-app 且 running）。
# 运行器给故障脚本的时间有限：本脚本把整个过程放到后台（nohup）执行并立即返回，日志在 $TMPDIR/cloudalbum-kill-test-<时间>.log。
# finally（trap EXIT）：只要停过实例，后台进程退出前一定把它启动回来。平台模式下卡片步骤声明了 expectedOutage。
set -euo pipefail
if [ "${1:-}" != --foreground ]; then
  phase="${1:-auto}"
  case "$phase" in service) echo "phase=service：停实例阶段跳过"; exit 0 ;; esac
  log="${TMPDIR:-/tmp}/cloudalbum-kill-test-$(date +%Y%m%dT%H%M%S).log"
  nohup bash "${BASH_SOURCE[0]}" --foreground "$@" > "$log" 2>&1 &
  echo "stop-instance running in the background (pid $!); log: $log"
  exit 0
fi
shift
phase="${1:-auto}"
down="${2:-300}"
hold="${3:-360}"
iid="${4:-${EXP_INSTANCE_ID:-}}"
[[ "$hold" =~ ^[0-9]+$ ]] && [ "$hold" -ge 60 ] && [ "$hold" -le 900 ] || { echo "instanceDownSec 必须是 60～900 的整数" >&2; exit 2; }
[[ "$down" =~ ^[0-9]+$ ]] || { echo "downSec 必须是整数" >&2; exit 2; }
platform=false
if [ -n "${CLOUDALBUM_PLATFORM_MODE:-}" ] || [ -f /etc/atl/session.env ]; then platform=true; fi
if [ "$phase" = auto ]; then
  if [ "$platform" = true ]; then phase=service; else phase=all; fi
fi
case "$phase" in
  instance|all) ;;
  service) echo "phase=service：停实例阶段跳过"; exit 0 ;;
  *) echo "phase 只能是 auto|service|instance|all" >&2; exit 2 ;;
esac
command -v aws >/dev/null 2>&1 || { echo "需要 AWS CLI（运维机 / 工作台）" >&2; exit 2; }

if [ -z "$iid" ]; then
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
  if [ -f "$root/.cloudalbum/state.json" ] && command -v jq >/dev/null 2>&1; then
    iid=$(jq -r '.base.instanceId // empty' "$root/.cloudalbum/state.json")
  fi
fi
if [ -z "$iid" ] && [ "$platform" = true ] && [ -f /etc/atl/session.env ]; then
  env_id=$(sed -n 's/^ATL_ENV_ID=//p' /etc/atl/session.env | tail -1 | tr -d '"')
  if [ -n "$env_id" ]; then
    iid=$(aws ec2 describe-instances --filters "Name=tag:atl:env-id,Values=$env_id" "Name=tag:atl:role,Values=lab-app" \
      "Name=instance-state-name,Values=running" --query 'Reservations[].Instances[].InstanceId' --output text | awk '{print $1}')
  fi
fi
[[ "$iid" =~ ^i-[0-9a-f]{8,17}$ ]] || { echo "不知道实验机的实例 ID：传第 4 个参数、EXP_INSTANCE_ID，或 --param instanceId=i-…" >&2; exit 2; }

if [ "$phase" = all ]; then
  echo "phase=all：等服务阶段结束（$((down + 120)) 秒）再停实例"
  sleep $((down + 120))
fi

stopped=false
restore() {
  if [ "$stopped" = true ]; then
    aws ec2 start-instances --instance-ids "$iid" >/dev/null || true
    aws ec2 wait instance-running --instance-ids "$iid" || true
  fi
}
trap restore EXIT
trap 'exit 130' INT TERM HUP
echo "stop $iid at $(date -u +%FT%TZ)"
aws ec2 stop-instances --instance-ids "$iid" >/dev/null
stopped=true
aws ec2 wait instance-stopped --instance-ids "$iid"
echo "stopped $iid at $(date -u +%FT%TZ); holding ${hold}s"
sleep "$hold"
echo "start $iid at $(date -u +%FT%TZ)"
aws ec2 start-instances --instance-ids "$iid" >/dev/null
aws ec2 wait instance-running --instance-ids "$iid"
stopped=false
trap - EXIT
# 管理通道（SSM Agent）恢复：最长 10 分钟
st=unknown
for _ in $(seq 1 60); do
  st=$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$iid" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo unknown)
  [ "$st" = Online ] && break
  sleep 10
done
echo "running $iid at $(date -u +%FT%TZ) (SSM PingStatus=$st)"
