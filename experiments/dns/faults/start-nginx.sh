#!/bin/bash
# dns/failover-drill: start Nginx again (the end fault of the drill). Root, through the delivery channel.
set -euo pipefail
nginx -t -q
systemctl start nginx
echo "{\"nginx\":\"$(systemctl is-active nginx)\",\"at\":\"$(date -u +%FT%TZ)\"}"
