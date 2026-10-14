#!/bin/bash
# notification/worker-stop（after = sns 档）：停掉 cloudalbum-worker。已经发布到 SNS 的消息照常投递到邮箱，
# 只有模块自带的收件队列（notification-inbox）会积压；start-worker.sh 之后积压被消费，sqs-copy 投递记录补齐。
set -euo pipefail
systemctl stop cloudalbum-worker
echo "stopped cloudalbum-worker at $(date -u +%FT%TZ)"
systemctl is-active cloudalbum-worker || true
