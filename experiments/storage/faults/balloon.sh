#!/bin/bash
# storage/ebs-growth：在数据卷上用 fallocate 占位，把使用率压到指定百分比；release 删除占位文件。
#   sudo bash balloon.sh fill 92      # 使用率压到 92%（已超过时不再占位）
#   sudo bash balloon.sh release
#   sudo bash balloon.sh status
# 经投递通道以 root 执行（ssh … sudo bash -s -- fill 92 < balloon.sh，或 SSM AWS-RunShellScript）。
set -euo pipefail
DATA_DIR="${CLOUDALBUM_DATA_DIR:-/var/lib/cloudalbum}"
BALLOON_DIR="${DATA_DIR}/lab"
BALLOON="${BALLOON_DIR}/balloon"
action="${1:-status}"

used_pct() { df --output=pcent "$DATA_DIR" | tail -1 | tr -dc '0-9'; }

case "$action" in
  fill)
    target="${2:-92}"
    [[ "$target" =~ ^[0-9]+$ ]] && (( target >= 50 && target <= 99 )) || { echo "目标百分比需要 50～99：$target" >&2; exit 2; }
    mkdir -p "$BALLOON_DIR"
    read -r size avail < <(df --output=size,avail -B1 "$DATA_DIR" | tail -1)
    used=$(( size - avail ))
    want=$(( size * target / 100 ))
    extra=$(( want - used ))
    if (( extra <= 0 )); then
      echo "当前使用率 $(used_pct)% 已不低于 ${target}%，不占位"
      exit 0
    fi
    current=0
    [[ -f "$BALLOON" ]] && current=$(stat -c %s "$BALLOON")
    fallocate -l $(( current + extra )) "$BALLOON"
    echo "balloon=$(( (current + extra) / 1048576 ))MiB used=$(used_pct)% at $(date -u +%FT%TZ)"
    ;;
  release)
    rm -f "$BALLOON"
    echo "released; used=$(used_pct)% at $(date -u +%FT%TZ)"
    ;;
  status)
    size=0
    [[ -f "$BALLOON" ]] && size=$(stat -c %s "$BALLOON")
    echo "balloon=$(( size / 1048576 ))MiB used=$(used_pct)%"
    ;;
  *) echo "用法：balloon.sh fill <百分比>|release|status" >&2; exit 2 ;;
esac
