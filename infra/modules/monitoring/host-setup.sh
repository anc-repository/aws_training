#!/bin/bash
# infra/modules/monitoring/host-setup.sh apply|revert — monitoring hostSetup (registry hostSetup + cwAgentFragment;
# 05-ops-observability.md convention 2 and monitoring section 6; 00-ec2-base.md 6.9). Root, idempotent, depends only on
# "release + modules.d/monitoring.env + modules.d/iam.env" (replay contract E12: run-hostsetup.sh --all restores it on a new
# root volume).
#   apply : IAM_CREDENTIALS must be role — the CloudWatch Agent only uses the instance profile; it never reads IAM_KEYS_* from
#           secrets.env and this project writes no separate credentials file for it (D5). With keys / none the fragment is
#           NOT delivered (memory / disk metrics and EMF unavailable -> the module probe reports degraded, CRED-002).
#           Installs amazon-cloudwatch-agent when missing and appends the monitoring fragment (mem, disk); with
#           METRICS_CW_MODE=emf also the EMF listener fragment (tcp/udp 25888 on 127.0.0.1).
#   revert: removes the monitoring fragments; stops the agent when no fragment of any module is left.
# The fragments are copied under unique names first (the agent keeps appended configs as file_<basename>, and other modules
# such as logging / tracing ship their own cwagent.json) and never edited by hand.
set -euo pipefail

APP=/opt/cloudalbum
SRC=$APP/infra/modules/monitoring
STAGE=/etc/cloudalbum-cwagent
CTL=/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl
AGENT_D=/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d
FRAG=$STAGE/cloudalbum-monitoring.json
FRAG_EMF=$STAGE/cloudalbum-monitoring-emf.json
MODULE_ENV=${CLOUDALBUM_MODULE_ENV:-/etc/cloudalbum/modules.d/monitoring.env}
IAM_ENV=/etc/cloudalbum/modules.d/iam.env
action=${1:-apply}

env_value() {   # env_value <KEY> <file> -> value (no shell evaluation; comments and quotes stripped)
  [ -f "$2" ] || return 0
  sed -n "s/^$1=//p" "$2" | tail -1 | sed -e 's/[[:space:]]*#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

has_fragment() {   # has_fragment <staged file> -> 0 when the agent still holds it
  local name
  name=$(basename "$1")
  [ -d "$AGENT_D" ] && compgen -G "$AGENT_D/*$name*" >/dev/null
}

remove_fragment() {   # remove_fragment <staged file>
  if [ -x "$CTL" ] && has_fragment "$1"; then
    "$CTL" -a remove-config -m ec2 -c "file:$1" -s >/dev/null 2>&1 || true
  fi
  rm -f "$1"
}

stop_when_empty() {
  [ -x "$CTL" ] || return 0
  if [ ! -d "$AGENT_D" ] || ! compgen -G "$AGENT_D/*" >/dev/null; then
    "$CTL" -a stop >/dev/null 2>&1 || true
  fi
}

append_fragment() {   # append_fragment <source> <staged file>
  install -d -m 0755 "$STAGE"
  install -m 0644 "$1" "$2"
  "$CTL" -a append-config -m ec2 -s -c "file:$2"
}

case "$action" in
  apply)
    mode=$(env_value IAM_CREDENTIALS "$IAM_ENV"); mode=${mode:-none}
    if [ "$mode" != role ]; then
      echo "monitoring host-setup: IAM_CREDENTIALS=$mode — the CloudWatch Agent only uses the instance profile; fragment not delivered" \
           "(memory / disk metrics and EMF are unavailable, monitoring is degraded; use scripts/module enable iam --mode role)" >&2
      remove_fragment "$FRAG_EMF"; remove_fragment "$FRAG"; stop_when_empty
      exit 0
    fi
    if ! rpm -q amazon-cloudwatch-agent >/dev/null 2>&1; then
      dnf install -y -q amazon-cloudwatch-agent
    fi
    [ -x "$CTL" ] || { echo "monitoring host-setup: $CTL missing after installation" >&2; exit 1; }
    append_fragment "$SRC/cwagent.json" "$FRAG"
    if [ "$(env_value METRICS_CW_MODE "$MODULE_ENV")" = emf ]; then
      append_fragment "$SRC/cwagent-emf.json" "$FRAG_EMF"
    else
      remove_fragment "$FRAG_EMF"
    fi
    systemctl enable amazon-cloudwatch-agent >/dev/null 2>&1 || true
    echo "monitoring host-setup: CloudWatch Agent $(rpm -q --qf '%{VERSION}' amazon-cloudwatch-agent) running with the monitoring fragment" >&2 ;;
  revert)
    remove_fragment "$FRAG_EMF"
    remove_fragment "$FRAG"
    stop_when_empty ;;
  *)
    echo "usage: $0 apply|revert" >&2; exit 64 ;;
esac
