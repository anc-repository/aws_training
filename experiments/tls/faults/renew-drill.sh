#!/bin/bash
# tls/renew-drill: certbot renew --dry-run, then --force-renewal of the module lineage on the instance (01#tls section 5
# step 7). Root, through the delivery channel (--fault-via ssh|ssm). The work is done by the tls hostSetup, which knows the
# certbot directories on the data volume and reloads Nginx through nginx-reload.sh. Prints one JSON line (before / after).
#   bash renew-drill.sh [--dry-run-only]
set -euo pipefail
HS=/opt/cloudalbum/infra/modules/tls/host-setup.sh
[ -f "$HS" ] || { echo '{"drill":false,"reason":"tls hostSetup not installed (release too old?)"}'; exit 1; }
if [ "${1:-}" = --dry-run-only ]; then
  exec bash "$HS" renew-drill
fi
exec bash "$HS" renew-drill --force
