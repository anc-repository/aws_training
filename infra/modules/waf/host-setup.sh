#!/bin/bash
# infra/modules/waf/host-setup.sh apply|revert — waf hostSetup (registry; 00-ec2-base.md 6.9; 01#waf sections 0 and 3).
# Root, idempotent, depends only on "release + modules.d/waf.env" (replay contract E12). It only renders the lab machine
# allow list WAF_LAB_ALLOW_CIDR (01 convention 13) as Nginx geo data:
#   apply : /etc/nginx/cloudalbum.d/waf-lab-allow.inc <- one "<IPv4/IPv6 CIDR> 1;" line per WAF_LAB_ALLOW_CIDR entry
#           (a module data file, 00-ec2-base.md 6.7: `.inc` is never globbed at http level, only an explicit include
#           reads it). The same list is the allow-lab rule of the web ACL (stack parameter LabAllowCidr).
#   revert: the file is emptied, not removed (an include of it must keep `nginx -t` passing).
# What it does NOT do: the denylist path unit (cloudalbum-denylist.path) and denylist-apply.sh belong to ec2 and are shared
# with threat-detection; limit_req zones and every $ca_* variable belong to ec2 (6.7 rule 2), so the exemption of these
# addresses from limit_req needs the ec2 consumer described in docs/implementation-notes.md (wave1-waf, "需要配合").
# Invalid entries are skipped with a warning (the stack parameter pattern and the scripts/module hook reject them earlier).
set -euo pipefail

D=${CLOUDALBUM_NGINX_D:-/etc/nginx/cloudalbum.d}
INC=$D/waf-lab-allow.inc
ENV_FILE=${CLOUDALBUM_MODULE_ENV:-/etc/cloudalbum/modules.d/waf.env}
action=${1:-apply}

env_value() {   # env_value <KEY> -> value from modules.d/waf.env (no shell evaluation)
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed -e 's/[[:space:]]*#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

valid_cidr() {
  local c=$1
  [[ $c =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?$ ]] && return 0
  [[ $c =~ ^[0-9A-Fa-f]*:[0-9A-Fa-f:]*(/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8]))?$ ]] && return 0
  return 1
}

write_inc() {   # write_inc <content> : atomic, 0644
  local tmp
  install -d -m 0755 "$D"
  tmp=$(mktemp "$D/.waf-lab-allow.XXXXXX")
  printf '%s\n' "$1" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$INC"
}

render() {
  local list cidr body n=0
  local -a items=()
  list=$(env_value WAF_LAB_ALLOW_CIDR)
  body="# rendered by infra/modules/waf/host-setup.sh from WAF_LAB_ALLOW_CIDR (01 convention 13); keep it empty outside load tests"
  IFS=',' read -r -a items <<< "$list"
  for cidr in "${items[@]}"; do
    cidr=${cidr//[[:space:]]/}
    [ -n "$cidr" ] || continue
    if valid_cidr "$cidr"; then
      body+=$'\n'"$cidr 1;"
      n=$((n + 1))
    else
      echo "waf host-setup: skipping invalid WAF_LAB_ALLOW_CIDR entry '$cidr'" >&2
    fi
  done
  write_inc "$body"
  echo "waf host-setup: $INC has $n entr$([ "$n" = 1 ] && echo y || echo ies)"
}

case "$action" in
  apply)  render ;;
  revert) write_inc "# emptied by the waf module (disabled)" ;;
  *)      echo "usage: $0 apply|revert" >&2; exit 64 ;;
esac
