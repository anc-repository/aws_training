#!/bin/bash
# /usr/local/lib/cloudalbum/render-fail2ban.sh — owned by ec2; logic defined by 05#threat-detection.
# Re-run after every module enable / disable (the entry may have changed):
#   - behind cdn or load-balancer (MODULE_CDN=on / MODULE_LOAD_BALANCER=on in modules.d): HTTP jails use the
#     cloudalbum-denylist action (Nginx deny list by real client IP); nftables would ban the proxy = every user
#   - direct access: nftables-multiport
# ignoreip = loopback + /etc/cloudalbum/fail2ban-ignoreip (operator addresses written by scripts/module).
# fail2ban unavailable (old AMI, package missing): nothing to do, the ec2 detector reports it.
set -euo pipefail

TPL=/opt/cloudalbum/infra/host/fail2ban/jail.d/cloudalbum.local.tpl
OUT=/etc/fail2ban/jail.d/cloudalbum.local
MD=/etc/cloudalbum/modules.d

if ! command -v fail2ban-client >/dev/null 2>&1 || [ ! -d /etc/fail2ban ]; then
  echo "render-fail2ban: fail2ban not installed, skipped"; exit 0
fi

banaction=nftables-multiport
for f in "$MD/cdn.env" "$MD/load-balancer.env"; do
  if [ -f "$f" ] && grep -Eq '^MODULE_(CDN|LOAD_BALANCER)=on[[:space:]]*$' "$f"; then banaction=cloudalbum-denylist; fi
done

ignore="127.0.0.1/8 ::1"
if [ -f /etc/cloudalbum/fail2ban-ignoreip ]; then
  while IFS= read -r ip; do
    [[ $ip =~ ^[0-9A-Fa-f.:/]+$ ]] && ignore="$ignore $ip"
  done < /etc/cloudalbum/fail2ban-ignoreip
fi

install -d -m 0755 /etc/fail2ban/jail.d
tmp=$(mktemp /etc/fail2ban/jail.d/.cloudalbum.XXXXXX)
sed -e "s|@@HTTP_BANACTION@@|$banaction|g" -e "s|@@IGNOREIP@@|$ignore|g" "$TPL" > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$OUT"
echo "render-fail2ban: HTTP jails -> $banaction"

if systemctl is-active --quiet fail2ban; then
  fail2ban-client reload >/dev/null || systemctl restart fail2ban
fi
