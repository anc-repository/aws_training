#!/bin/bash
# iam/imds-ssrf —— IMDSv2 与 SSRF（02#iam 第 5 节步骤 3）。在实例上运行：bash experiments/iam/imds-ssrf.sh
# 1) 模拟“只能发 GET 的 SSRF”：不带会话令牌直接 GET 凭证路径，IMDSv2 必需时返回 401；
# 2) 正规流程：PUT /latest/api/token（带 TTL 头）取令牌，再带令牌 GET，返回 200 与角色名。
# 只输出状态码与角色名，不读取、不输出凭证内容。最后一行 EXP-RESULT:<json> 供运行器读取。
set -uo pipefail
IMDS="http://169.254.169.254"
path="/latest/meta-data/iam/security-credentials/"
no_token=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "${IMDS}${path}" || echo 000)
token=$(curl -s -m 3 -X PUT "${IMDS}/latest/api/token" -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
with_token=000
role=""
if [[ -n "$token" ]]; then
  with_token=$(curl -s -o /dev/null -m 3 -w '%{http_code}' -H "X-aws-ec2-metadata-token: ${token}" "${IMDS}${path}" || echo 000)
  role=$(curl -s -m 3 -H "X-aws-ec2-metadata-token: ${token}" "${IMDS}${path}" | head -1 | tr -cd 'A-Za-z0-9+=,.@_-' || true)
fi
hop=$(curl -s -m 3 -H "X-aws-ec2-metadata-token: ${token}" "${IMDS}/latest/meta-data/instance-id" >/dev/null 2>&1 && echo ok || echo n/a)
echo "不带令牌的 GET：HTTP ${no_token}（IMDSv2 必需时应为 401）"
echo "PUT 取令牌后 GET：HTTP ${with_token}，角色：${role:-（无，实例未挂实例配置文件）}"
v2_required=false
[[ "$no_token" == "401" ]] && v2_required=true
echo "EXP-RESULT:{\"getWithoutToken\":${no_token},\"getWithToken\":${with_token},\"imdsV2Required\":${v2_required},\"role\":\"${role}\",\"instanceIdReadable\":\"${hop}\"}"
