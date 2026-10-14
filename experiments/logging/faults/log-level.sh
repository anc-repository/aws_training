#!/bin/bash
# experiments/logging/faults/log-level.sh debug|info — runtime hot key logLevel (05#logging section 3, D7) for the optional
# debug-volume experiment. Root on the instance (delivered over ssh / SSM like every fault script; shipped in the release as
# /opt/cloudalbum/experiments/logging/faults/log-level.sh). config=ssm instead: put /cloudalbum/<env>/runtime/logLevel.
set -euo pipefail
level=${1:-info}
case "$level" in debug|info|warn|error) ;; *) echo "usage: $0 debug|info|warn|error" >&2; exit 64 ;; esac
/usr/local/sbin/cloudalbum-runtime set logLevel "\"$level\""
