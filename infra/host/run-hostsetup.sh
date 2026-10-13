#!/bin/bash
# /usr/local/lib/cloudalbum/run-hostsetup.sh — replay contract (00-ec2-base.md 6.9, E12). Root only.
#   run-hostsetup.sh <id> [apply|revert]   one module
#   run-hostsetup.sh --all                 every module that has /etc/cloudalbum/modules.d/<id>.env (local tiers included),
#                                          in registry topological order (modules/hostsetup-order.txt, written by scripts/release)
# For each module, everything comes from "release + modules.d/<id>.env + secrets.env":
#   nginxFragments  infra/modules/<id>/nginx/*.tpl -> /etc/nginx/cloudalbum.d/<name> (`# target: server` -> cloudalbum.server.d);
#                   ${VAR} placeholders are filled from modules.d/<id>.env (`# defaults: K=V` header for missing keys)
#   systemdDropIns  infra/modules/<id>/systemd/50-<id>.conf -> cloudalbum-<unit>.service.d/ (`# units: worker` header;
#                   default api + worker; api drop-ins are copied to cloudalbum-api@.service.d/ as well); directives are
#                   checked against a whitelist (no User=, ExecStart=, EnvironmentFile=, ...)
#   hostSetup       <script> apply|revert (CLOUDALBUM_MODULE_ID / CLOUDALBUM_MODULE_ENV exported)
# Nginx changes go through nginx-reload.sh; when `nginx -t` fails the fragment directories are restored (2.5 rule 3).
# jq programs use $id as a jq variable (single quotes are intended)
# shellcheck disable=SC2016
set -euo pipefail

APP=/opt/cloudalbum
REG=$APP/modules/registry.json
ORDER=$APP/modules/hostsetup-order.txt
MD=/etc/cloudalbum/modules.d
LIB=/usr/local/lib/cloudalbum
SYSD=/etc/systemd/system

[ -f "$REG" ] || { echo "run-hostsetup: $REG missing (release archive too old?)" >&2; exit 1; }

target=${1:-}; action=${2:-apply}
[ -n "$target" ] || { echo "usage: $0 <id>|--all [apply|revert]" >&2; exit 64; }
case "$action" in apply|revert) ;; *) echo "usage: $0 <id>|--all [apply|revert]" >&2; exit 64 ;; esac

reg() { jq -r --arg id "$1" "$2" "$REG"; }

declare -A ENVV=()
load_env() {   # load_env <file>
  ENVV=()
  local line k v
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ $line =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    k=${BASH_REMATCH[1]}; v=${BASH_REMATCH[2]}
    v=${v%%[[:space:]]#*}
    v=${v#\"}; v=${v%\"}; v=${v#\'}; v=${v%\'}
    ENVV[$k]=$v
  done < "$1"
}

render_template() {   # render_template <src> -> stdout (only ${KNOWN_KEY} placeholders are replaced)
  local content k kv
  # "# defaults: K=V K2=V2" in the first lines of a template seeds keys missing from modules.d/<id>.env
  for kv in $(head -5 "$1" | sed -n 's/^# defaults:[[:space:]]*//p'); do
    k=${kv%%=*}
    [[ $k =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && [ -z "${ENVV[$k]:-}" ] && ENVV[$k]=${kv#*=}
  done
  content=$(cat "$1")
  for k in "${!ENVV[@]}"; do content=${content//\$\{$k\}/${ENVV[$k]}}; done
  printf '%s\n' "$content"
}

dropin_allowed() {   # whitelist of 00-ec2-base.md 6.8 (+ CPUWeight / Nice / MemoryMax for image-processing worker isolation)
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    [[ $line =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ $line =~ ^\[(Unit|Service)\][[:space:]]*$ ]] && continue
    [[ $line =~ ^(After|Wants|RequiresMountsFor|ReadWritePaths|ReadOnlyPaths|CPUWeight|Nice|MemoryMax|MemoryHigh)= ]] && continue
    [[ $line =~ ^Environment=\"?NODE_OPTIONS= ]] && continue
    echo "run-hostsetup: drop-in directive not allowed: $line" >&2
    return 1
  done < "$1"
}

fragment_dest() {   # fragment_dest <id> <template path> -> destination path
  local src=$1 name dir=/etc/nginx/cloudalbum.d
  name=$(basename "${2%.tpl}")
  head -5 "$2" | grep -q '^# target: server' && dir=/etc/nginx/cloudalbum.server.d
  case "$name" in "$src"-*) ;; *) echo "run-hostsetup: fragment $name must start with '$src-'" >&2; return 1 ;; esac
  echo "$dir/$name"
}

dropin_units() {   # dropin_units <file> -> api / worker words
  local u
  u=$(sed -n 's/^# units:[[:space:]]*//p' "$1" | head -1)
  echo "${u:-api worker}"
}

NGINX_TOUCHED=0
SYSTEMD_TOUCHED=0

module_apply() {
  local id=$1 f dest name u hs
  load_env "$MD/$id.env"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    dest=$(fragment_dest "$id" "$APP/$f")
    render_template "$APP/$f" > "$dest.tmp"
    chmod 0644 "$dest.tmp"; mv -f "$dest.tmp" "$dest"
    NGINX_TOUCHED=1
  done < <(reg "$id" '.modules[$id].nginxFragments // [] | .[]')
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    name=$(basename "$f")
    [[ $name == 50-"$id".conf ]] || { echo "run-hostsetup: drop-in $name must be named 50-$id.conf" >&2; return 1; }
    dropin_allowed "$APP/$f"
    for u in $(dropin_units "$APP/$f"); do
      install -d -m 0755 "$SYSD/cloudalbum-$u.service.d"
      install -m 0644 "$APP/$f" "$SYSD/cloudalbum-$u.service.d/$name"
      if [ "$u" = api ]; then
        install -d -m 0755 "$SYSD/cloudalbum-api@.service.d"
        install -m 0644 "$APP/$f" "$SYSD/cloudalbum-api@.service.d/$name"
      fi
    done
    SYSTEMD_TOUCHED=1
  done < <(reg "$id" '.modules[$id].systemdDropIns // [] | .[]')
  hs=$(reg "$id" '.modules[$id].hostSetup // ""')
  if [ -n "$hs" ] && [ "$hs" != infra/userdata/l0-bootstrap.sh ] && [ -f "$APP/$hs" ]; then
    CLOUDALBUM_MODULE_ID=$id CLOUDALBUM_MODULE_ENV="$MD/$id.env" bash "$APP/$hs" apply
    NGINX_TOUCHED=1
  fi
}

module_revert() {
  local id=$1 f dest name u hs
  load_env "$MD/$id.env"
  hs=$(reg "$id" '.modules[$id].hostSetup // ""')
  if [ -n "$hs" ] && [ "$hs" != infra/userdata/l0-bootstrap.sh ] && [ -f "$APP/$hs" ]; then
    CLOUDALBUM_MODULE_ID=$id CLOUDALBUM_MODULE_ENV="$MD/$id.env" bash "$APP/$hs" revert
    NGINX_TOUCHED=1
  fi
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    dest=$(fragment_dest "$id" "$APP/$f")
    rm -f "$dest"; NGINX_TOUCHED=1
  done < <(reg "$id" '.modules[$id].nginxFragments // [] | .[]')
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    name=$(basename "$f")
    for u in api api@ worker; do rm -f "$SYSD/cloudalbum-$u.service.d/$name"; done
    SYSTEMD_TOUCHED=1
  done < <(reg "$id" '.modules[$id].systemdDropIns // [] | .[]')
}

if [ "$target" = --all ]; then
  if [ -f "$ORDER" ]; then mapfile -t ids < "$ORDER"; else mapfile -t ids < <(jq -r '.modules | keys_unsorted[]' "$REG"); fi
else
  jq -e --arg id "$target" '.modules[$id]' "$REG" >/dev/null || { echo "run-hostsetup: unknown module $target" >&2; exit 64; }
  ids=("$target")
fi

backup=$(mktemp -d /var/tmp/cloudalbum-nginx-backup.XXXXXX)
cp -a /etc/nginx/cloudalbum.d /etc/nginx/cloudalbum.server.d "$backup/"
trap 'rm -rf "$backup"' EXIT

for id in "${ids[@]}"; do
  [ "$id" = ec2 ] && continue
  if [ "$target" = --all ] && [ ! -f "$MD/$id.env" ]; then continue; fi
  echo "run-hostsetup: $action $id"
  if [ "$action" = apply ]; then module_apply "$id"; else module_revert "$id"; fi
done

if [ "$SYSTEMD_TOUCHED" = 1 ]; then systemctl daemon-reload; fi
if [ "$NGINX_TOUCHED" = 1 ] && ! "$LIB/nginx-reload.sh"; then
  echo "run-hostsetup: nginx -t failed, restoring the previous fragments" >&2
  rm -rf /etc/nginx/cloudalbum.d /etc/nginx/cloudalbum.server.d
  cp -a "$backup/cloudalbum.d" "$backup/cloudalbum.server.d" /etc/nginx/
  "$LIB/nginx-reload.sh" || true
  exit 1
fi
