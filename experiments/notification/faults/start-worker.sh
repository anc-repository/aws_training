#!/bin/bash
# notification/worker-stop：重新启动 cloudalbum-worker（收件队列的积压随后被消费）。
set -euo pipefail
systemctl start cloudalbum-worker
echo "started cloudalbum-worker at $(date -u +%FT%TZ)"
sleep 2
systemctl is-active cloudalbum-worker || true
