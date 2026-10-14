#!/bin/bash
# dns/failover-drill: stop Nginx on the instance so that the Route 53 health check of origin.<domain> fails (01#dns section 5
# step 3). Root, through the delivery channel (--fault-via ssh|ssm). faults/start-nginx.sh restores it at the end.
set -euo pipefail
systemctl stop nginx
echo "{\"nginx\":\"stopped\",\"at\":\"$(date -u +%FT%TZ)\"}"
