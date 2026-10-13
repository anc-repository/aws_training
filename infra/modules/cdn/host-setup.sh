#!/bin/bash
# infra/modules/cdn/host-setup.sh apply|revert — cdn hostSetup (registry; 00-ec2-base.md 6.9; 01#cdn section 6).
# Root, idempotent, depends only on "release + modules.d/cdn.env + secrets.env" (replay contract E12):
#   apply : slot-origin-verify.inc <- ORIGIN_VERIFY (+ ORIGIN_VERIFY_PREVIOUS during rotation) from secrets.env (root 0600,
#           derived copy, D5 exception); cdn-realip-ranges.inc <- CloudFront origin-facing ranges (ip-ranges.json, no AWS
#           credentials needed); install and start cloudalbum-cdn-cf-ranges.timer (daily refresh).
#           The 8080 server block itself (cdn-origin.conf) is rendered by run-hostsetup.sh from nginxFragments.
#   revert: empty the slot (the file stays: 00-entry.conf includes it), remove the ranges file and the timer.
#   refresh-ranges: only refresh cdn-realip-ranges.inc (called by the timer) and reload Nginx.
# SECRETS_DRIVER=secretsmanager: scripts/module passes the current value in CLOUDALBUM_ORIGIN_VERIFY (never written to disk
# except into the slot file).
set -euo pipefail

D=/etc/nginx/cloudalbum.d
SLOT=$D/slot-origin-verify.inc
RANGES=$D/cdn-realip-ranges.inc
SYSD=/etc/systemd/system
LIB=/usr/local/lib/cloudalbum
SECRETS=/etc/cloudalbum/secrets.env
action=${1:-apply}

secret_value() {   # secret_value <KEY> -> value from secrets.env (no shell evaluation)
  [ -f "$SECRETS" ] || return 0
  sed -n "s/^$1=//p" "$SECRETS" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

render_slot() {
  local cur prev tmp
  cur=${CLOUDALBUM_ORIGIN_VERIFY:-$(secret_value ORIGIN_VERIFY)}
  prev=${CLOUDALBUM_ORIGIN_VERIFY_PREVIOUS:-$(secret_value ORIGIN_VERIFY_PREVIOUS)}
  [ -n "$cur" ] || { echo "cdn host-setup: ORIGIN_VERIFY missing in secrets.env" >&2; exit 1; }
  [[ $cur =~ ^[A-Za-z0-9_-]+$ ]] || { echo "cdn host-setup: ORIGIN_VERIFY must be URL-safe base64" >&2; exit 1; }
  tmp=$(mktemp "$D/.slot-origin-verify.XXXXXX")
  chmod 0600 "$tmp"
  {
    echo "# rendered by infra/modules/cdn/host-setup.sh (derived copy of secrets.env ORIGIN_VERIFY; root 0600)"
    echo "\"$cur\" 1;"
    if [ -n "$prev" ] && [ "$prev" != "$cur" ] && [[ $prev =~ ^[A-Za-z0-9_-]+$ ]]; then echo "\"$prev\" 1;"; fi
  } > "$tmp"
  mv -f "$tmp" "$SLOT"
}

render_ranges() {
  local json tmp
  tmp=$(mktemp "$D/.cdn-realip-ranges.XXXXXX")
  if json=$(curl -fsS -m 20 https://ip-ranges.amazonaws.com/ip-ranges.json); then
    {
      echo "# CloudFront origin-facing ranges (service CLOUDFRONT_ORIGIN_FACING), rendered $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      jq -r '.prefixes[] | select(.service == "CLOUDFRONT_ORIGIN_FACING") | "set_real_ip_from \(.ip_prefix);"' <<< "$json" | sort -u
      jq -r '.ipv6_prefixes[]? | select(.service == "CLOUDFRONT_ORIGIN_FACING") | "set_real_ip_from \(.ipv6_prefix);"' <<< "$json" | sort -u
    } > "$tmp"
    if [ "$(grep -c '^set_real_ip_from' "$tmp")" -gt 0 ]; then
      chmod 0644 "$tmp"; mv -f "$tmp" "$RANGES"; return 0
    fi
  fi
  rm -f "$tmp"
  if [ ! -f "$RANGES" ]; then   # keep Nginx loadable; the realip of 8080 falls back to the CloudFront edge address
    echo "# CloudFront ranges unavailable at $(date -u +%Y-%m-%dT%H:%M:%SZ); will be refreshed by cloudalbum-cdn-cf-ranges.timer" > "$RANGES"
    chmod 0644 "$RANGES"
  fi
  echo "cdn host-setup: could not download ip-ranges.json, kept the previous ranges" >&2
}

install_timer() {
  cat > "$SYSD/cloudalbum-cdn-cf-ranges.service" <<'EOF'
# owned by the cdn module (infra/modules/cdn/host-setup.sh)
[Unit]
Description=CloudAlbum cdn: refresh CloudFront origin-facing ranges for the 8080 realip
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/cloudalbum/infra/modules/cdn/host-setup.sh refresh-ranges
EOF
  cat > "$SYSD/cloudalbum-cdn-cf-ranges.timer" <<'EOF'
# owned by the cdn module (infra/modules/cdn/host-setup.sh)
[Unit]
Description=CloudAlbum cdn: daily refresh of CloudFront origin-facing ranges

[Timer]
OnCalendar=*-*-* 05:10:00 Asia/Tokyo
RandomizedDelaySec=1800
Persistent=true

[Install]
WantedBy=timers.target
EOF
  chmod 0644 "$SYSD/cloudalbum-cdn-cf-ranges.service" "$SYSD/cloudalbum-cdn-cf-ranges.timer"
  systemctl daemon-reload
  systemctl enable --now cloudalbum-cdn-cf-ranges.timer
}

case "$action" in
  apply)
    render_slot
    render_ranges
    install_timer ;;
  refresh-ranges)
    render_ranges
    "$LIB/nginx-reload.sh" ;;
  revert)
    systemctl disable --now cloudalbum-cdn-cf-ranges.timer 2>/dev/null || true
    rm -f "$SYSD/cloudalbum-cdn-cf-ranges.service" "$SYSD/cloudalbum-cdn-cf-ranges.timer"
    systemctl daemon-reload
    printf '# emptied by the cdn module (disabled)\n' > "$SLOT"; chmod 0600 "$SLOT"
    rm -f "$RANGES" "$D/cdn-origin.conf" ;;
  *)
    echo "usage: $0 apply|revert|refresh-ranges" >&2; exit 64 ;;
esac
