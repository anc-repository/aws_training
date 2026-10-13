#!/bin/bash
# /usr/local/lib/cloudalbum/render-vpc-cidr.sh — owned by ec2. Renders /etc/nginx/cloudalbum-vpc-cidr.inc
# (`allow <CIDR>;` per VPC IPv4 block) from IMDSv2; re-run after network migrations (postattach does it).
# Used by vpc-hmac internal endpoints (/internal/legacy-auth). Without IMDS (not on EC2) the file is left unchanged.
set -euo pipefail

OUT=/etc/nginx/cloudalbum-vpc-cidr.inc
IMDS=http://169.254.169.254/latest

token=$(curl -fsS -m 2 -X PUT "$IMDS/api/token" -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' 2>/dev/null) || {
  echo "render-vpc-cidr: IMDS unavailable, keeping $OUT" >&2; exit 0; }
md() { curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $token" "$IMDS/meta-data/$1"; }

mac=$(md mac)
cidrs=$(md "network/interfaces/macs/$mac/vpc-ipv4-cidr-blocks")
tmp=$(mktemp /etc/nginx/.cloudalbum-vpc-cidr.XXXXXX)
{
  echo "# rendered by render-vpc-cidr.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ) from IMDS (vpc-ipv4-cidr-blocks)"
  while IFS= read -r c; do
    [[ $c =~ ^[0-9.]+/[0-9]+$ ]] && echo "allow $c;"
  done <<< "$cidrs"
} > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$OUT"
