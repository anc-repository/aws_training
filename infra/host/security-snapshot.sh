#!/bin/bash
# /usr/local/lib/cloudalbum/security-snapshot.sh — run as root every 2 minutes (cloudalbum-security-snapshot.timer).
# Writes /var/lib/cloudalbum/security/snapshot.json (root:cloudalbum 0640) atomically. Structure defined by
# 00-ec2-base.md section 7 (schemaVersion 1; sections host / sshd / fail2ban; fields are only ever added).
# Readers: ec2 detector, shell-access, threat-detection, compliance, vuln-scan.
set -uo pipefail

SEC=/var/lib/cloudalbum/security
OUT=$SEC/snapshot.json
[ -d "$SEC" ] || { echo "security-snapshot: $SEC missing (data volume not mounted?)" >&2; exit 1; }

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ---- units and timers ----
units_json='{}'
for u in nginx cloudalbum-api cloudalbum-worker cloudalbum-denylist.path cloudalbum-backup.timer \
         cloudalbum-healthcheck.timer cloudalbum-security-snapshot.timer cloudalbum-vuln-scan.timer \
         fail2ban chronyd sshd amazon-ssm-agent amazon-cloudwatch-agent; do
  st=$(systemctl is-active "$u" 2>/dev/null); st=${st:-unknown}
  units_json=$(jq -c --arg k "$u" --arg v "$st" '. + {($k): $v}' <<< "$units_json")
done
while read -r unit _; do
  [ -n "$unit" ] || continue
  st=$(systemctl is-active "$unit" 2>/dev/null)
  units_json=$(jq -c --arg k "${unit%.service}" --arg v "${st:-unknown}" '. + {($k): $v}' <<< "$units_json")
done < <(systemctl list-units --all --plain --no-legend 'cloudalbum-api@*.service' 2>/dev/null)

timers_json='{}'
for t in cloudalbum-backup.timer cloudalbum-healthcheck.timer cloudalbum-security-snapshot.timer cloudalbum-vuln-scan.timer; do
  last=$(systemctl show -p LastTriggerUSec --value "$t" 2>/dev/null)
  next=$(systemctl show -p NextElapseUSecRealtime --value "$t" 2>/dev/null)
  act=$(systemctl is-active "$t" 2>/dev/null)
  timers_json=$(jq -c --arg k "$t" --arg a "${act:-unknown}" --arg l "${last:-}" --arg n "${next:-}" \
                '. + {($k): {active: $a, lastTrigger: $l, nextElapse: $n}}' <<< "$timers_json")
done

# ---- time sync (chronyc -c tracking: CSV; field 2 = source, 5 = system time offset in s, 14 = leap status) ----
time_json='{"synchronized":false,"source":null,"offsetMs":null}'
if command -v chronyc >/dev/null 2>&1 && tr=$(chronyc -c tracking 2>/dev/null); then
  IFS=, read -r -a f <<< "$tr"
  time_json=$(jq -cn --arg src "${f[1]:-}" --arg off "${f[4]:-0}" --arg leap "${f[13]:-}" \
    '{synchronized: ($leap == "Normal"), source: $src, offsetMs: (($off | tonumber? // 0) * 1000 | fabs)}')
fi

# ---- listening TCP sockets ----
listening_json=$(ss -ltnH 2>/dev/null | awk '{print $4}' | sort -u | jq -R . | jq -cs .)

# ---- nginx reload / deny-list state (written by nginx-reload.sh) ----
nginx_json='{}'
[ -s "$SEC/nginx-state.json" ] && nginx_json=$(jq -c . "$SEC/nginx-state.json" 2>/dev/null || echo '{}')

# ---- manual drop-ins (reported as degraded by the ec2 detector) ----
dropins_json=$(find /etc/systemd/system -path '*.service.d/99-local.conf' 2>/dev/null | jq -R . | jq -cs .)

release=""
[ -f /opt/cloudalbum/VERSION ] && release=$(head -1 /opt/cloudalbum/VERSION)
[ -n "$release" ] || release=$(basename "$(readlink -f /opt/cloudalbum 2>/dev/null || echo unknown)")

# ---- sshd (AL2023 has no /var/log/secure: journal only) ----
sshd_listening=false
ss -ltnH '( sport = :22 )' 2>/dev/null | grep -q . && sshd_listening=true
sshd_log=$(journalctl -u sshd --since '-24h' -o cat --no-pager 2>/dev/null || true)
failures=$(grep -cE 'Failed (password|publickey)|Invalid user|authentication failure' <<< "$sshd_log" || true)
logins_json=$(grep -E '^Accepted ' <<< "$sshd_log" | tail -5 \
  | awk '{for (i = 1; i <= NF; i++) { if ($i == "for") u = $(i+1); if ($i == "from") a = $(i+1) } print u "@" a}' \
  | jq -R . | jq -cs .)

# ---- fail2ban ----
f2b_json='{"available":false,"jails":[]}'
if command -v fail2ban-client >/dev/null 2>&1; then
  jails='[]'
  if list=$(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p'); then
    for j in ${list//,/ }; do
      st=$(fail2ban-client status "$j" 2>/dev/null || true)
      cur=$(sed -n 's/.*Currently banned:[[:space:]]*//p' <<< "$st" | head -1)
      tot=$(sed -n 's/.*Total banned:[[:space:]]*//p' <<< "$st" | head -1)
      jails=$(jq -c --arg n "$j" --arg c "${cur:-0}" --arg t "${tot:-0}" \
              '. + [{name: $n, currentlyBanned: ($c | tonumber? // 0), totalBanned: ($t | tonumber? // 0)}]' <<< "$jails")
    done
  fi
  banaction=""
  [ -f /etc/fail2ban/jail.d/cloudalbum.local ] && \
    banaction=$(sed -n '/^\[cloudalbum-http\]/,/^\[/s/^banaction[[:space:]]*=[[:space:]]*//p' /etc/fail2ban/jail.d/cloudalbum.local | head -1)
  f2b_json=$(jq -cn --argjson j "$jails" --arg b "$banaction" '{available: true, httpBanaction: $b, jails: $j}')
fi

tmp=$(mktemp "$SEC/.snapshot.XXXXXX")
jq -n \
  --arg at "$now" --arg release "$release" \
  --argjson units "$units_json" --argjson timers "$timers_json" --argjson time "$time_json" \
  --argjson listening "$listening_json" --argjson nginx "$nginx_json" --argjson dropins "$dropins_json" \
  --argjson sshdListening "$sshd_listening" --arg failures "${failures:-0}" --argjson logins "$logins_json" \
  --argjson f2b "$f2b_json" '
  {
    schemaVersion: 1,
    generatedAt: $at,
    host: { units: $units, timers: $timers, time: $time, listening: $listening, nginx: $nginx,
            manualDropins: $dropins, release: $release },
    sshd: { listening: $sshdListening, failures24h: ($failures | tonumber? // 0), recentLogins: $logins },
    fail2ban: $f2b
  }' > "$tmp" || { rm -f "$tmp"; exit 1; }
chown root:cloudalbum "$tmp"
chmod 0640 "$tmp"
mv -f "$tmp" "$OUT"
