# /etc/profile.d/atl.sh — export the session facts written by ATL-WorkstationSetup (03 §4.6 step 3) in login shells
if [ -r /etc/atl/session.env ]; then
  set -a
  . /etc/atl/session.env
  set +a
fi
