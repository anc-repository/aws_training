#!/bin/bash
# monitoring/resolution：占满一个核 <spikeSec> 秒（05#monitoring 第 5 节步骤 4）。经投递通道以 root 在实验机上执行。
# 只起一个忙循环进程（t3 / t4g.small 有 2 个 vCPU，整机 CPU 约 50%），放到后台（setsid）立即返回，
# timeout 到期自动结束，不需要清理；投递通道断开也不会留下常驻进程。
set -euo pipefail
sec="${1:-180}"
[[ "$sec" =~ ^[0-9]+$ ]] && [ "$sec" -ge 10 ] && [ "$sec" -le 900 ] || { echo "spikeSec 必须是 10～900 的整数" >&2; exit 2; }
setsid timeout "$sec" bash -c 'while :; do :; done' </dev/null >/dev/null 2>&1 &
echo "cpu spike ${sec}s from $(date -u +%FT%TZ) (pid $!)"
