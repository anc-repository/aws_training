#!/bin/bash
# database/failover（after = RDS Multi-AZ）：强制故障转移。在运维机上执行（--fault-via local），使用部署者凭证（AWS CLI）；
# 应用身份没有 rds:RebootDBInstance 权限。实例 ID 见 scripts/module status database 的栈输出。
#   DB_INSTANCE_ID=cloudalbum-lab-db [AWS_REGION=ap-northeast-1] bash rds-failover.sh
set -euo pipefail
: "${DB_INSTANCE_ID:?需要 DB_INSTANCE_ID（RDS 实例标识符）}"
region_args=()
[[ -n "${AWS_REGION:-}" ]] && region_args=(--region "$AWS_REGION")
multi_az=$(aws rds describe-db-instances "${region_args[@]}" --db-instance-identifier "$DB_INSTANCE_ID" --query 'DBInstances[0].MultiAZ' --output text)
if [[ "$multi_az" != "True" ]]; then
  echo "实例 $DB_INSTANCE_ID 不是 Multi-AZ：--force-failover 不可用（用 MultiAz=true 重新部署 database 栈）" >&2
  exit 2
fi
aws rds reboot-db-instance "${region_args[@]}" --db-instance-identifier "$DB_INSTANCE_ID" --force-failover --query 'DBInstance.DBInstanceStatus' --output text
echo "failover requested for $DB_INSTANCE_ID at $(date -u +%FT%TZ)"
