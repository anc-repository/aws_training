#!/bin/bash
# cache/fail-open（after 档）：临时撤销 / 恢复 sg-cache 上“来自实例安全组的 6379 入站”规则。
# 在运维机上执行（--fault-via local），使用部署者凭证（AWS CLI）；不在实例上执行，应用身份没有 ec2:*SecurityGroup* 权限。
#   CACHE_SG_ID=sg-…  APP_SG_ID=sg-…  bash revoke-sg.sh revoke|restore
# 两个安全组 ID 可在 scripts/module status cache / ec2 的栈输出中找到。
set -euo pipefail
action="${1:-}"
: "${CACHE_SG_ID:?需要 CACHE_SG_ID（sg-cache）}"
: "${APP_SG_ID:?需要 APP_SG_ID（实例安全组）}"
port="${CACHE_PORT:-6379}"
perm="IpProtocol=tcp,FromPort=${port},ToPort=${port},UserIdGroupPairs=[{GroupId=${APP_SG_ID}}]"
case "$action" in
  revoke)  aws ec2 revoke-security-group-ingress --group-id "$CACHE_SG_ID" --ip-permissions "$perm" ;;
  restore) aws ec2 authorize-security-group-ingress --group-id "$CACHE_SG_ID" --ip-permissions "$perm" ;;
  *) echo "用法：revoke-sg.sh revoke|restore" >&2; exit 2 ;;
esac
echo "${action} ${CACHE_SG_ID} tcp/${port} from ${APP_SG_ID} at $(date -u +%FT%TZ)"
