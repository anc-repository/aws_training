#!/bin/bash
# queue/upload-burst（after = sqs 档）：kill -9 worker。未删除的消息在可见性超时（120 秒）后重新出现，
# systemd（Restart=always）随后自动拉起 worker，任务一个不丢，少量可能被处理两次（processed_jobs 去重）。
set -euo pipefail
systemctl kill -s SIGKILL cloudalbum-worker
echo "killed cloudalbum-worker (SIGKILL) at $(date -u +%FT%TZ)"
sleep 2
systemctl is-active cloudalbum-worker || true
