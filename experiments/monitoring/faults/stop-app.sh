#!/bin/bash
# monitoring/kill-test 的“停服务”阶段（05#monitoring 第 5 节步骤 2；06 PM-M30）：停 api 与 worker，<downSec> 秒后自动启动。
# 经投递通道以 root 在实验机上执行：ssh … sudo bash -s -- <phase> <downSec> < stop-app.sh，或 SSM AWS-RunShellScript
# （平台模式一律 SSM，06 PM-42）。phase=instance 时什么也不做（那一阶段由 stop-instance.sh 在运维机上执行）。
#   phase auto：平台模式（/etc/cloudalbum/platform.env 存在）= service，独立模式 = all
# 恢复由 systemd 的临时定时器（systemd-run --on-active）负责：投递通道断开、运行器超时都不影响服务被启动回来；
# 脚本本身停完服务就返回。本地告警评估器在 worker 里，它与 api 一起停：这段时间里本地一侧完全沉默——这正是对比点。
set -euo pipefail
phase="${1:-auto}"
down="${2:-300}"
[[ "$down" =~ ^[0-9]+$ ]] && [ "$down" -ge 30 ] && [ "$down" -le 900 ] || { echo "downSec 必须是 30～900 的整数" >&2; exit 2; }
if [ "$phase" = auto ]; then
  if [ -f /etc/cloudalbum/platform.env ]; then phase=service; else phase=all; fi
fi
case "$phase" in
  service|all) ;;
  instance) echo "phase=instance：停服务阶段跳过"; exit 0 ;;
  *) echo "phase 只能是 auto|service|instance|all" >&2; exit 2 ;;
esac

unit="cloudalbum-killtest-restore-$(date +%s)"
# 先安排好恢复，再停服务：即使接下来的命令失败，服务也会按时启动
systemd-run --unit="$unit" --collect --on-active="${down}s" /bin/systemctl start cloudalbum-worker cloudalbum-api >/dev/null
if ! systemctl stop cloudalbum-api cloudalbum-worker; then
  systemctl start cloudalbum-worker cloudalbum-api || true
  systemctl stop "$unit.timer" 2>/dev/null || true
  echo "停止服务失败，已恢复" >&2
  exit 1
fi
echo "stopped cloudalbum-api cloudalbum-worker at $(date -u +%FT%TZ); ${unit}.timer starts them again in ${down}s"
