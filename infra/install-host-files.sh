#!/bin/bash
# infra/install-host-files.sh — run by l0-bootstrap.sh (install phase) from the release: /opt/cloudalbum/infra/install-host-files.sh
# Root volume only, idempotent. Installs every ec2-owned host file (00-ec2-base.md 3.4, 6.7, 6.8):
#   Nginx (nginx.conf replaces the distribution default, conf.d/cloudalbum.conf, locations, proxy, 00-entry, 00-acme-challenge;
#   upstream / vpc-cidr / slot files only when missing: modules own their content), systemd units + drop-in directories,
#   nginx hardening drop-in, journald limit, logrotate, sshd hardening (validated with sshd -t), fail2ban filter / action,
#   /usr/local/lib/cloudalbum/*.sh helpers and /usr/local/sbin/cloudalbum-{postattach,predetach,runtime}.
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)     # /opt/cloudalbum/infra
LIB=/usr/local/lib/cloudalbum
SYSD=/etc/systemd/system

[ "$(id -u)" = 0 ] || { echo "install-host-files.sh must run as root" >&2; exit 1; }

# ---------- Nginx ----------
install -d -m 0755 /etc/nginx/conf.d /etc/nginx/cloudalbum.d /etc/nginx/cloudalbum.server.d
install -m 0644 "$SRC/nginx/nginx.conf"                  /etc/nginx/nginx.conf
install -m 0644 "$SRC/nginx/cloudalbum.conf"             /etc/nginx/conf.d/cloudalbum.conf
install -m 0644 "$SRC/nginx/cloudalbum_locations.conf"   /etc/nginx/cloudalbum_locations.conf
install -m 0644 "$SRC/nginx/cloudalbum_proxy.conf"       /etc/nginx/cloudalbum_proxy.conf
install -m 0644 "$SRC/nginx/cloudalbum.d/00-entry.conf"  /etc/nginx/cloudalbum.d/00-entry.conf
install -m 0644 "$SRC/nginx/cloudalbum.server.d/00-acme-challenge.conf" /etc/nginx/cloudalbum.server.d/00-acme-challenge.conf
# owned by load-balancer (upstream), render-vpc-cidr.sh, or modules (slots): seed only when missing
[ -e /etc/nginx/cloudalbum_upstream.conf ] || install -m 0644 "$SRC/nginx/cloudalbum_upstream.conf" /etc/nginx/cloudalbum_upstream.conf
[ -e /etc/nginx/cloudalbum-vpc-cidr.inc ]  || install -m 0644 "$SRC/nginx/cloudalbum-vpc-cidr.inc"  /etc/nginx/cloudalbum-vpc-cidr.inc
for slot in slot-alb-hops.inc slot-atl-frame-ancestors.inc; do
  [ -e "/etc/nginx/cloudalbum.d/$slot" ] || install -m 0644 "$SRC/nginx/cloudalbum.d/$slot" "/etc/nginx/cloudalbum.d/$slot"
done
# holds a derived copy of origin-verify when cdn is enabled: root only (D5 exception)
[ -e /etc/nginx/cloudalbum.d/slot-origin-verify.inc ] || \
  install -m 0600 "$SRC/nginx/cloudalbum.d/slot-origin-verify.inc" /etc/nginx/cloudalbum.d/slot-origin-verify.inc
# the deny list Nginx includes: root-owned copy written only by denylist-apply.sh after validation (seed an empty one)
if [ ! -f /etc/nginx/cloudalbum-denylist.conf ] || [ -L /etc/nginx/cloudalbum-denylist.conf ]; then
  rm -f /etc/nginx/cloudalbum-denylist.conf
  install -o root -g root -m 0644 /dev/null /etc/nginx/cloudalbum-denylist.conf
fi
# the distribution default server block would conflict with default_server (E10)
rm -f /etc/nginx/conf.d/default.conf

# `http2 on;` needs nginx >= 1.25.1; older builds take `listen ... http2` instead
if command -v nginx >/dev/null 2>&1; then
  v=$(nginx -v 2>&1 | sed -n 's|.*nginx/\([0-9][0-9.]*\).*|\1|p')
  if [ -n "$v" ] && [ "$(printf '%s\n1.25.1\n' "$v" | sort -V | head -1)" != 1.25.1 ]; then
    sed -i -e '/^[[:space:]]*http2 on;/d' \
           -e 's|listen 443 ssl default_server;|listen 443 ssl http2 default_server;|' \
           -e 's|listen \[::\]:443 ssl default_server;|listen [::]:443 ssl http2 default_server;|' \
           /etc/nginx/conf.d/cloudalbum.conf
    echo "install-host-files: nginx $v < 1.25.1, using 'listen ... http2'"
  fi
fi

# ---------- systemd ----------
for u in cloudalbum-api.service cloudalbum-api@.service cloudalbum-worker.service \
         cloudalbum-backup.service cloudalbum-backup.timer \
         cloudalbum-security-snapshot.service cloudalbum-security-snapshot.timer \
         cloudalbum-healthcheck.service cloudalbum-healthcheck.timer \
         cloudalbum-vuln-scan.service cloudalbum-vuln-scan.timer \
         cloudalbum-denylist.path cloudalbum-denylist.service; do
  install -m 0644 "$SRC/systemd/$u" "$SYSD/$u"
done
install -d -m 0755 "$SYSD/nginx.service.d" "$SYSD/cloudalbum-api.service.d" "$SYSD/cloudalbum-api@.service.d" \
                   "$SYSD/cloudalbum-worker.service.d" /etc/systemd/journald.conf.d
install -m 0644 "$SRC/systemd/nginx.service.d/10-cloudalbum.conf" "$SYSD/nginx.service.d/10-cloudalbum.conf"
if ! cmp -s "$SRC/systemd/journald-cloudalbum.conf" /etc/systemd/journald.conf.d/cloudalbum.conf; then
  install -m 0644 "$SRC/systemd/journald-cloudalbum.conf" /etc/systemd/journald.conf.d/cloudalbum.conf
  systemctl restart systemd-journald || true
fi

# ---------- logrotate ----------
install -m 0644 "$SRC/logrotate/cloudalbum" /etc/logrotate.d/cloudalbum

# ---------- helpers ----------
install -d -m 0755 "$LIB" /usr/local/sbin
for s in render-fail2ban.sh render-vpc-cidr.sh security-snapshot.sh vuln-scan.sh healthcheck.sh \
         denylist-apply.sh denylist-edit.sh nginx-reload.sh run-hostsetup.sh; do
  install -m 0755 "$SRC/host/$s" "$LIB/$s"
done
for s in cloudalbum-postattach cloudalbum-predetach cloudalbum-runtime; do
  install -m 0755 "$SRC/host/$s" "/usr/local/sbin/$s"
done

# ---------- sshd hardening (only kept when sshd accepts it) ----------
if [ -d /etc/ssh/sshd_config.d ]; then
  dst=/etc/ssh/sshd_config.d/40-cloudalbum.conf
  if ! cmp -s "$SRC/host/sshd_config.d/40-cloudalbum.conf" "$dst"; then
    install -m 0600 "$SRC/host/sshd_config.d/40-cloudalbum.conf" "$dst"
    if sshd -t; then
      systemctl reload sshd 2>/dev/null || true
    else
      echo "install-host-files: sshd -t rejected 40-cloudalbum.conf, removing it" >&2
      rm -f "$dst"
    fi
  fi
fi

# ---------- fail2ban (rendered later by render-fail2ban.sh once modules.d is known) ----------
if [ -d /etc/fail2ban ]; then
  install -d -m 0755 /etc/fail2ban/filter.d /etc/fail2ban/action.d /etc/fail2ban/jail.d
  install -m 0644 "$SRC/host/fail2ban/filter.d/cloudalbum-http.conf"     /etc/fail2ban/filter.d/cloudalbum-http.conf
  install -m 0644 "$SRC/host/fail2ban/action.d/cloudalbum-denylist.conf" /etc/fail2ban/action.d/cloudalbum-denylist.conf
fi

echo "install-host-files: done"
