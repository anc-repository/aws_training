#!/bin/bash
# /usr/local/lib/cloudalbum/vuln-scan.sh — daily (cloudalbum-vuln-scan.timer, root). Installed by ec2; the content belongs
# to vuln-scan (06#vuln-scan): the local stand-in for Amazon Inspector.
#   - OS: `dnf updateinfo list --security` (pending security advisories by severity)
#   - application: `npm audit --omit=dev --json` in /opt/cloudalbum (needs package-lock.json and internet access)
# Output: /var/lib/cloudalbum/security/vuln-scan.json (root:cloudalbum 0640).
set -uo pipefail

SEC=/var/lib/cloudalbum/security
OUT=$SEC/vuln-scan.json
[ -d "$SEC" ] || { echo "vuln-scan: $SEC missing" >&2; exit 1; }

dnf_json='{"available":false}'
if command -v dnf >/dev/null 2>&1 && list=$(dnf -q updateinfo list --security 2>/dev/null); then
  # lines: <advisory> <severity>/Sec. <package>
  dnf_json=$(awk 'NF >= 3 && $2 ~ /\/Sec\.$/ { sev = $2; sub(/\/Sec\.$/, "", sev); print $1 "\t" sev "\t" $3 }' <<< "$list" \
    | jq -R 'split("\t") | {id: .[0], severity: .[1], package: .[2]}' | jq -cs '
      {available: true, total: length,
       bySeverity: (group_by(.severity) | map({(.[0].severity): length}) | add // {}),
       advisories: (.[0:200])}')
fi

npm_json='{"available":false}'
if command -v npm >/dev/null 2>&1 && [ -f /opt/cloudalbum/package-lock.json ]; then
  raw=$(cd /opt/cloudalbum && timeout 300 npm audit --omit=dev --json 2>/dev/null) || true
  if [ -n "${raw:-}" ] && jq -e . >/dev/null 2>&1 <<< "$raw"; then
    npm_json=$(jq -c '{available: true, total: (.metadata.vulnerabilities.total // 0),
                       bySeverity: (.metadata.vulnerabilities // {} | del(.total))}' <<< "$raw")
  fi
fi

tmp=$(mktemp "$SEC/.vuln-scan.XXXXXX")
jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson dnf "$dnf_json" --argjson npm "$npm_json" \
  '{schemaVersion: 1, generatedAt: $at, source: "local", dnf: $dnf, npm: $npm}' > "$tmp" || { rm -f "$tmp"; exit 1; }
chown root:cloudalbum "$tmp"
chmod 0640 "$tmp"
mv -f "$tmp" "$OUT"
