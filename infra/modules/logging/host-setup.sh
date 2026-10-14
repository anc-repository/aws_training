#!/bin/bash
# infra/modules/logging/host-setup.sh apply|revert — logging hostSetup (registry; 00-ec2-base.md 6.9; 05#logging sections 2, 6;
# 05 group convention 2 "one shared CloudWatch Agent"). Root, idempotent, depends only on "release + modules.d/logging.env"
# (replay contract E12: run-hostsetup.sh --all re-runs it on a replaced instance).
#   LOG_CW_SHIPPER=sdk (default): nothing to install on the host (the application ships its own lines); a fragment left from
#     an earlier agent mode is removed.
#   LOG_CW_SHIPPER=agent:
#     apply : refuse in keys mode (the Agent only uses the instance profile; no second credential file, D5);
#             dnf install amazon-cloudwatch-agent when missing; render infra/modules/logging/cwagent.json with the log group
#             names of modules.d/logging.env into $FRAG; amazon-cloudwatch-agent-ctl -a append-config -m ec2 -s -c file:$FRAG.
#     revert: -a remove-config -c file:$FRAG (with -s while other fragments remain, e.g. monitoring); -a stop after the last one.
# Merging with other modules' fragments (monitoring, tracing): the fragment only contains logs.logs_collected.files (no
# "agent" section, no top-level logs keys), and the rendered file name is unique (cloudalbum-logging.json -> the agent keeps
# it as amazon-cloudwatch-agent.d/file_cloudalbum-logging.json), so append-config never replaces another module's fragment.
set -euo pipefail

APP=/opt/cloudalbum
SRC=$APP/infra/modules/logging/cwagent.json
AGENT_ETC=/opt/aws/amazon-cloudwatch-agent/etc
FRAG=$AGENT_ETC/cloudalbum-logging.json
CTL=/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl
ENV_FILE=${CLOUDALBUM_MODULE_ENV:-/etc/cloudalbum/modules.d/logging.env}
action=${1:-apply}

env_value() {   # env_value <file> <KEY> -> value (no shell evaluation)
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -1 | sed -e 's/[[:space:]]*#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

credentials_mode() {   # IAM_CREDENTIALS of the instance: modules.d/iam.env, then cloudalbum.env; default none
  local v
  v=$(env_value /etc/cloudalbum/modules.d/iam.env IAM_CREDENTIALS)
  [ -n "$v" ] || v=$(env_value /etc/cloudalbum/cloudalbum.env IAM_CREDENTIALS)
  echo "${v:-none}"
}

other_fragments() {   # number of agent config fragments that are not ours
  local d=$AGENT_ETC/amazon-cloudwatch-agent.d
  [ -d "$d" ] || { echo 0; return; }
  find "$d" -maxdepth 1 -type f ! -name 'file_cloudalbum-logging.json' | wc -l
}

remove_fragment() {
  [ -f "$FRAG" ] || return 0
  if [ -x "$CTL" ]; then
    if [ "$(other_fragments)" -gt 0 ]; then
      "$CTL" -a remove-config -m ec2 -c "file:$FRAG" -s || true
    else
      "$CTL" -a remove-config -m ec2 -c "file:$FRAG" || true
      "$CTL" -a stop || true
    fi
  fi
  rm -f "$FRAG"
}

render_fragment() {
  local app nginx tmp
  app=$(env_value "$ENV_FILE" LOG_CW_GROUP_APP)
  nginx=$(env_value "$ENV_FILE" LOG_CW_GROUP_NGINX)
  for v in "$app" "$nginx"; do
    [[ $v =~ ^/[A-Za-z0-9/._-]{1,500}$ ]] || { echo "logging host-setup: invalid log group name '$v' in $ENV_FILE" >&2; exit 1; }
  done
  install -d -m 0755 "$AGENT_ETC"
  tmp=$(mktemp "$AGENT_ETC/.cloudalbum-logging.XXXXXX")
  sed -e "s#\${LOG_CW_GROUP_APP}#$app#g" -e "s#\${LOG_CW_GROUP_NGINX}#$nginx#g" "$SRC" > "$tmp"
  if grep -q '\${' "$tmp"; then rm -f "$tmp"; echo "logging host-setup: unresolved placeholder in $SRC" >&2; exit 1; fi
  chmod 0644 "$tmp"
  mv -f "$tmp" "$FRAG"
}

case "$action" in
  apply)
    shipper=$(env_value "$ENV_FILE" LOG_CW_SHIPPER)
    if [ "${shipper:-sdk}" != agent ]; then
      remove_fragment                                # switched back to sdk: no agent fragment of ours
      exit 0
    fi
    mode=$(credentials_mode)
    if [ "$mode" != role ]; then
      echo "logging host-setup: LOG_CW_SHIPPER=agent needs IAM_CREDENTIALS=role (found $mode): the CloudWatch Agent only uses the instance profile; use Shipper=sdk" >&2
      exit 1
    fi
    if [ ! -x "$CTL" ]; then
      dnf install -y amazon-cloudwatch-agent
    fi
    render_fragment
    "$CTL" -a append-config -m ec2 -s -c "file:$FRAG"
    ;;
  revert)
    remove_fragment
    ;;
  *)
    echo "usage: $0 apply|revert" >&2; exit 64 ;;
esac
