# /etc/nginx/cloudalbum.d/slot-origin-verify.inc — ec2 slot, written by the cdn hostSetup (root:root 0600):
#   "<current X-Origin-Verify>" 1;   and, during rotation, "<previous value>" 1;
# Rendered from secrets.env ORIGIN_VERIFY (derived copy, D5 exception). Emptied (not deleted) when cdn is disabled.
