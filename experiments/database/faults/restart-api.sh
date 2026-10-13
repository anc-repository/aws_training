#!/bin/bash
# database/failover（before = sqlite 档）：重启 api，作为 RDS Multi-AZ 故障转移的基线对照（整站短暂不可用），
# 记录写失败区间；“停止实例 → 启动实例”的整站不可用时长按 README 手工测量。
# 经投递通道以 root 执行：ssh … sudo bash -s < restart-api.sh，或 SSM AWS-RunShellScript。
set -euo pipefail
systemctl restart cloudalbum-api
echo "restarted cloudalbum-api at $(date -u +%FT%TZ)"
