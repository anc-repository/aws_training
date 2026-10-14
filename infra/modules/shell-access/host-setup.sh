#!/bin/bash
# infra/modules/shell-access/host-setup.sh apply|revert|render — shell-access hostSetup (registry; 00-ec2-base.md 6.9; 05#shell-access
# sections 2, 6). Root, idempotent, depends only on "release + modules.d/shell-access.env" (replay contract E12: a replaced
# instance gets the user and the sudoers fragment back from run-hostsetup.sh --all).
#   apply : the Session Manager runAs user SSM_SESSION_RUN_AS (default cloudalbum-ops; 6.9 allows cloudalbum- system users)
#           and its restricted sudoers fragment /etc/sudoers.d/40-cloudalbum-ops (checked with visudo -cf before install):
#             systemctl status <unit> --no-pager    journalctl -u <unit> --no-pager [-n 50|200]   (read-only, NOEXEC)
#             systemctl restart cloudalbum-api / cloudalbum-worker, nginx -t, systemctl reload nginx
#           with <unit> = cloudalbum-api | cloudalbum-worker. Every command is listed with its exact arguments: sudoers(5) lets
#           a `*` in the argument part match anything including spaces, so `journalctl -u cloudalbum-*` would also allow
#           `-u cloudalbum-api -u sshd` (any unit) or `--vacuum-time=1s` / `--rotate` (rewriting the system journal as root);
#           extra or reordered arguments are denied (wave1-fix). --no-pager is mandatory: a pager (less) running as root could
#           open other files. Everything else (cat /etc/cloudalbum/secrets.env, sudo -i, ...) is denied. The default ssm-user
#           and AL2023's ec2-user both have password-less sudo, so "runAs ec2-user" would not lower anything.
#   revert: remove the sudoers fragment and the user (its running sessions are terminated first).
#   render: print the sudoers fragment only (review and tests).
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

# the units the operator may inspect (exact names: no wildcard ever reaches the sudoers argument list)
OPS_UNITS=(cloudalbum-api cloudalbum-worker)

read_commands() {   # one exact command per line (fixed argument order; --no-pager always present)
  local u
  for u in "${OPS_UNITS[@]}"; do
    printf '%s\n' \
      "/usr/bin/systemctl status $u --no-pager" \
      "/usr/bin/systemctl --no-pager status $u" \
      "/usr/bin/journalctl -u $u --no-pager" \
      "/usr/bin/journalctl --no-pager -u $u" \
      "/usr/bin/journalctl -u $u -n 50 --no-pager" \
      "/usr/bin/journalctl -u $u -n 200 --no-pager"
  done
}

render_sudoers() {
  local read_alias
  read_alias=$(read_commands | paste -sd, - | sed 's/,/, /g')
  case "$read_alias" in *'*'*|*'?'*|*'['*) echo "shell-access host-setup: wildcard in the sudoers argument list" >&2; return 1 ;; esac
  cat <<EOF
# owned by the shell-access module (infra/modules/shell-access/host-setup.sh); do not edit — re-rendered on replay
# Session Manager opens shells as $run_as (session preferences runAsDefaultUser); this is all it may run as root.
# Exact commands only: a '*' in the argument part of a sudoers command matches anything, spaces included.
Defaults:$run_as !visiblepw, env_reset, secure_path=/usr/sbin:/usr/bin
Cmnd_Alias CA_OPS_READ = $read_alias
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
  render)   # print the sudoers fragment (review / tests; no change on the host)
    render_sudoers ;;
  *)
    echo "usage: $0 apply|revert|render" >&2; exit 64 ;;
esac
