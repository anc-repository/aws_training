#!/bin/bash
# experiments/_lib/leak-scan.sh —— 明文 AWS 访问密钥的泄露面扫描（02#iam 第 5 节步骤 2；在实例上以 root 运行）。
#
#   sudo bash experiments/_lib/leak-scan.sh [--json]
#
# 按“位置类别”统计 AKIA（长期密钥）与 ASIA（临时凭证）形状的命中数；只输出计数与文件路径，绝不输出密钥本身。
# 扫描：/etc/cloudalbum（及其指向的数据卷 etc/）、/var/lib/cloudalbum 其余目录（含同盘本地备份 backup/）、/var/log、
#       journalctl -u 'cloudalbum-*'、各进程的 /proc/<pid>/environ、/root/.aws、/home/*/.aws、shell 历史。
# 最后一行输出 `EXP-RESULT:<json>`，供 experiments 运行器（shell 场景）读取。
set -uo pipefail

AKIA_RE='AKIA[0-9A-Z]{16}'
ASIA_RE='ASIA[0-9A-Z]{16}'
DATA_DIR="${CLOUDALBUM_DATA_DIR:-/var/lib/cloudalbum}"
declare -A AKIA=() ASIA=() FILES=()
total_akia=0
total_asia=0

count_in() { # <类别> [文件]：没有文件时从 stdin 读（先落到临时文件，两次 grep 都要读）
  local klass="$1"; shift
  local a s tmp=""
  if [[ $# -eq 0 ]]; then
    tmp=$(mktemp)
    cat > "$tmp"
    set -- "$tmp"
  fi
  a=$(grep -E -o -a -e "$AKIA_RE" "$@" 2>/dev/null | wc -l)
  s=$(grep -E -o -a -e "$ASIA_RE" "$@" 2>/dev/null | wc -l)
  [[ -n "$tmp" ]] && rm -f "$tmp"
  AKIA[$klass]=$(( ${AKIA[$klass]:-0} + a ))
  ASIA[$klass]=$(( ${ASIA[$klass]:-0} + s ))
}

scan_dir() { # <类别> <目录>
  local klass="$1" dir="$2"
  [[ -e "$dir" ]] || return 0
  local hits
  hits=$(grep -R -l -E -a -I --exclude-dir=proc -e "$AKIA_RE" -e "$ASIA_RE" "$dir" 2>/dev/null | head -50)
  if [[ -n "$hits" ]]; then
    FILES[$klass]="${FILES[$klass]:-}${hits}"$'\n'
    while IFS= read -r f; do count_in "$klass" "$f"; done <<< "$hits"
  else
    AKIA[$klass]=${AKIA[$klass]:-0}
    ASIA[$klass]=${ASIA[$klass]:-0}
  fi
}

[[ $EUID -eq 0 ]] || echo "注意：没有以 root 运行，部分位置无法读取（结果偏少）" >&2

scan_dir etc /etc/cloudalbum
scan_dir etc-volume "${DATA_DIR}/etc"
scan_dir backup "${DATA_DIR}/backup"
for d in "${DATA_DIR}"/*; do
  case "$(basename "$d")" in etc|backup|uploads) ;; *) scan_dir data-volume "$d" ;; esac
done
scan_dir var-log /var/log
scan_dir aws-cli /root/.aws
for h in /home/*/.aws; do scan_dir aws-cli "$h"; done
for h in /root/.bash_history /home/*/.bash_history; do [[ -f "$h" ]] && scan_dir shell-history "$h"; done
if command -v journalctl >/dev/null 2>&1; then
  journalctl -u 'cloudalbum-*' --no-pager -o cat 2>/dev/null | count_in journal
fi
for env in /proc/[0-9]*/environ; do
  tr '\0' '\n' < "$env" 2>/dev/null | count_in process-env
done

json='{"locations":{'
sep=''
locations=0
for klass in $(printf '%s\n' "${!AKIA[@]}" "${!ASIA[@]}" | sort -u); do
  a=${AKIA[$klass]:-0}; s=${ASIA[$klass]:-0}
  total_akia=$(( total_akia + a )); total_asia=$(( total_asia + s ))
  (( a + s > 0 )) && locations=$(( locations + 1 ))
  printf '%-14s AKIA=%-4s ASIA=%-4s\n' "$klass" "$a" "$s"
  if [[ -n "${FILES[$klass]:-}" ]]; then printf '%s' "${FILES[$klass]}" | sed '/^$/d; s/^/    /'; fi
  json+="${sep}\"${klass}\":{\"akia\":${a},\"asia\":${s}}"
  sep=','
done
json+="},\"total\":{\"akia\":${total_akia},\"asia\":${total_asia}},\"locationsWithHits\":${locations},\"root\":$([[ $EUID -eq 0 ]] && echo true || echo false)}"
echo "合计：AKIA=${total_akia} ASIA=${total_asia}（有命中的位置类别 ${locations} 个）"
echo "EXP-RESULT:${json}"
