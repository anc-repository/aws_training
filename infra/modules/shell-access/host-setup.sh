#!/bin/bash
# infra/modules/shell-access/host-setup.sh apply|revert — shell-access hostSetup (registry; 00-ec2-base.md 6.9; 05#shell-access
# sections 2, 6). Root, idempotent, depends only on "release + modules.d/shell-access.env" (replay contract E12: a replaced
# instance gets the user and the sudoers fragment back from run-hostsetup.sh --all).
#   apply : the Session Manager runAs user SSM_SESSION_RUN_AS (default cloudalbum-ops; 6.9 allows cloudalbum- system users)
#           and its restricted sudoers fragment /etc/sudoers.d/40-cloudalbum-ops (checked with visudo -cf before install):
#             systemctl status cloudalbum-*         journalctl -u cloudalbum-*       (read-only, NOEXEC: no pager shell escape)
#             systemctl restart cloudalbum-api / cloudalbum-worker, nginx -t, systemctl reload nginx
#           Everything else (cat /etc/cloudalbum/secrets.env, sudo -i, ...) is denied. The default ssm-user and AL2023's ec2-user
#           both have password-less sudo, so "runAs ec2-user" would not lower anything.
#   revert: remove the sudoers fragment and the user (its running sessions are terminated first).
# The SSM Agent itself is not restarted here: this script runs through Run Command once the delivery channel is SSM, and
# restarting the agent would kill the command that runs it (scripts/module restarts it over ssh before closing port 22).
set -euo pipefail

ENV_FILE=${CLOUDALBUM_MODULE_ENV:-/etc/cloudalbum/modules.d/shell-access.env}
SUDOERS=/etc/sudoers.d/40-cloudalbum-ops
action=${1:-apply}

env_value() {   # env_value <file> <KEY> -> value (no shell evaluation)
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -1 | sed -e 's/[[:space:]]*#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

run_as=$(env_value "$ENV_FILE" SSM_SESSION_RUN_AS)
run_as=${run_as:-cloudalbum-ops}
[[ $run_as =~ ^cloudalbum-[a-z0-9-]{1,24}$ ]] || { echo "shell-access host-setup: SSM_SESSION_RUN_AS must be a cloudalbum-* user (got '$run_as')" >&2; exit 1; }

render_sudoers() {
  cat <<EOF
# owned by the shell-access module (infra/modules/shell-access/host-setup.sh); do not edit — re-rendered on replay
# Session Manager opens shells as $run_as (session preferences runAsDefaultUser); this is all it may run as root.
Defaults:$run_as !visiblepw, env_reset, secure_path=/usr/sbin:/usr/bin
Cmnd_Alias CA_OPS_READ = /usr/bin/systemctl status cloudalbum-*, /usr/bin/systemctl --no-pager status cloudalbum-*, \\
                         /usr/bin/journalctl -u cloudalbum-*, /usr/bin/journalctl --no-pager -u cloudalbum-*
Cmnd_Alias CA_OPS_RESTART = /usr/bin/systemctl restart cloudalbum-api, /usr/bin/systemctl restart cloudalbum-worker, \\
                            /usr/bin/systemctl restart cloudalbum-api cloudalbum-worker
Cmnd_Alias CA_OPS_NGINX = /usr/sbin/nginx -t, /usr/bin/systemctl reload nginx
$run_as ALL=(root) NOPASSWD: NOEXEC: CA_OPS_READ
$run_as ALL=(root) NOPASSWD: CA_OPS_RESTART, CA_OPS_NGINX
EOF
}

case "$action" in
  apply)
    if ! id -u "$run_as" >/dev/null 2>&1; then
      useradd --system --create-home --home-dir "/home/$run_as" --shell /bin/bash \
        --comment "CloudAlbum operator (Session Manager runAs; shell-access module)" "$run_as"
    fi
    tmp=$(mktemp /etc/sudoers.d/.cloudalbum-ops.XXXXXX)
    render_sudoers > "$tmp"
    chmod 0440 "$tmp"
    if ! visudo -cf "$tmp" >/dev/null; then
      rm -f "$tmp"
      echo "shell-access host-setup: the sudoers fragment does not pass visudo -c" >&2
      exit 1
    fi
    mv -f "$tmp" "$SUDOERS"
    ;;
  revert)
    rm -f "$SUDOERS"
    if id -u "$run_as" >/dev/null 2>&1; then
      pkill -KILL -u "$run_as" 2>/dev/null || true
      userdel -r "$run_as" 2>/dev/null || userdel "$run_as" || true
    fi
    ;;
  *)
    echo "usage: $0 apply|revert" >&2; exit 64 ;;
esac
