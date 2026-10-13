#!/bin/bash
# iam/leak-scan —— 泄露面扫描（02#iam 第 5 节步骤 2）。在实例上运行：
#   sudo bash experiments/iam/leak-scan.sh
#   sudo -E npm run exp -- iam --label keys --scenario leak-scan     # 经运行器，结果写入 _results/
# keys 模式预期在 secrets.env、同盘本地备份等多处扫出 AKIA；role 模式扫不到长期凭证。
# 可选：AMI / EBS 快照挂载后用 SCAN_ROOT=/mnt/snap 再扫一次（见 README）。
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${SCAN_ROOT:-}" ]]; then
  export CLOUDALBUM_DATA_DIR="${SCAN_ROOT%/}/var/lib/cloudalbum"
fi
exec bash "${here}/../_lib/leak-scan.sh" "$@"
