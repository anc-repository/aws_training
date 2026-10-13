#!/bin/bash
# iam/refresh-role-creds —— revoke 实验（role 模式）的恢复步骤（02#iam 第 5 节步骤 4）。在运维机上运行，使用部署者凭证：
#   INSTANCE_ID=i-… [PROFILE_NAME=CloudAlbumAppProfile] TARGET=http://<EIP> CLOUDALBUM_ADMIN_TOKEN=… bash refresh-role-creds.sh
# 1) aws ec2 replace-iam-instance-profile-association：让实例换取新会话（被撤销的旧会话凭证随之作废）；
# 2) POST /api/lab/iam/refresh（即 AwsCredentialsPort.forceRefresh()），观察 /api/lab/aws-ping 多久恢复。
set -euo pipefail
: "${INSTANCE_ID:?需要 INSTANCE_ID}"
: "${TARGET:?需要 TARGET（应用基址）}"
: "${CLOUDALBUM_ADMIN_TOKEN:?需要 CLOUDALBUM_ADMIN_TOKEN}"
assoc=$(aws ec2 describe-iam-instance-profile-associations --filters "Name=instance-id,Values=${INSTANCE_ID}" \
  --query 'IamInstanceProfileAssociations[0].[AssociationId,IamInstanceProfile.Arn]' --output text)
assoc_id=$(echo "$assoc" | awk '{print $1}')
profile_arn=$(echo "$assoc" | awk '{print $2}')
[[ -n "$assoc_id" && "$assoc_id" != "None" ]] || { echo "实例 ${INSTANCE_ID} 没有实例配置文件关联" >&2; exit 2; }
if [[ -n "${PROFILE_NAME:-}" ]]; then profile_spec="Name=${PROFILE_NAME}"; else profile_spec="Arn=${profile_arn}"; fi
aws ec2 replace-iam-instance-profile-association --association-id "$assoc_id" --iam-instance-profile "$profile_spec" \
  --query 'IamInstanceProfileAssociation.State' --output text
echo "replaced association at $(date -u +%FT%TZ)"
curl -s -o /dev/null -w 'POST /api/lab/iam/refresh → HTTP %{http_code}\n' -X POST \
  -H "Authorization: Bearer ${CLOUDALBUM_ADMIN_TOKEN}" -H 'Content-Type: application/json' -d '{}' "${TARGET%/}/api/lab/iam/refresh"
