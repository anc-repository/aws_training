# /etc/fail2ban/jail.d/cloudalbum.local — rendered by /usr/local/lib/cloudalbum/render-fail2ban.sh (do not edit by hand).
# @@HTTP_BANACTION@@ = nftables-multiport (direct access) or cloudalbum-denylist (behind cdn / load-balancer)
# @@IGNOREIP@@       = 127.0.0.1/8 ::1 + /etc/cloudalbum/fail2ban-ignoreip (operator addresses written by scripts/module)
[DEFAULT]
ignoreip = @@IGNOREIP@@
bantime = 1h
findtime = 10m
maxretry = 10

[sshd]
enabled = true
backend = systemd
banaction = nftables-multiport
maxretry = 5

[cloudalbum-http]
enabled = true
filter = cloudalbum-http
logpath = /var/lib/cloudalbum/logs/nginx-access.json
backend = auto
port = http,https,8080
maxretry = 30
banaction = @@HTTP_BANACTION@@

[nginx-limit-req]
enabled = true
logpath = /var/log/nginx/error.log
backend = auto
port = http,https,8080
maxretry = 20
banaction = @@HTTP_BANACTION@@
