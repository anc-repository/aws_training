#!/bin/bash
# queue/upload-burst（before = memory 档）：重启 api。内存队列中排队与在途的任务随进程一起丢失，
# 缩略图由对账任务分钟级找回，邮件 / 通知任务真的丢了（biz.jobs_lost > 0）。
# 经投递通道以 root 执行：ssh … sudo bash -s < restart-api.sh，或 SSM AWS-RunShellScript。
set -euo pipefail
systemctl restart cloudalbum-api
echo "restarted cloudalbum-api at $(date -u +%FT%TZ)"
