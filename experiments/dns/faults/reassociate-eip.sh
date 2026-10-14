#!/bin/bash
# dns/ip-change-drill: simulate "the instance got a new IP" (01#dns section 5 steps 1-2). Runs on the operator machine /
# CloudShell / workstation with the deployer identity (npm run exp ... --fault-via local); calls only the AWS CLI.
#   bash reassociate-eip.sh swap [--upsert] [--env <env>]   allocate a temporary EIP, associate it with the instance
#                                                          (--upsert: UPSERT the Route 53 record of the dns stack to it)
#   bash reassociate-eip.sh restore [--env <env>]           associate the original EIP again (and UPSERT the record back),
#                                                          release the temporary EIP. MUST run: otherwise the base stack's
#                                                          EIP association no longer matches reality
#   bash reassociate-eip.sh status [--env <env>]
# The instance, the original allocation and the record are discovered from the stacks cloudalbum-<env>-ec2 / -dns.
# State: ${TMPDIR:-/tmp}/cloudalbum-dns-ip-drill-<env>.json (read by ip-change-drill.ts). Prints one JSON line.
set -euo pipefail

action=${1:-status}; shift || true
upsert=0
ENV_NAME=${CLOUDALBUM_ENV:-lab}
while [ $# -gt 0 ]; do
  case "$1" in
    --upsert) upsert=1; shift ;;
    --env) ENV_NAME=${2:-lab}; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done
[[ $ENV_NAME =~ ^[a-z][a-z0-9-]{1,15}$ ]] || { echo "invalid env $ENV_NAME" >&2; exit 64; }
STATE="${TMPDIR:-/tmp}/cloudalbum-dns-ip-drill-${ENV_NAME}.json"
command -v aws >/dev/null || { echo '{"error":"aws CLI not found"}'; exit 1; }
command -v jq >/dev/null || { echo '{"error":"jq not found"}'; exit 1; }

output() {   # output <stack> <OutputKey>
  aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text 2>/dev/null | sed 's/^None$//'
}

upsert_record() {   # upsert_record <zone> <name> <ip> <ttl>
  local batch
  batch=$(jq -cn --arg name "$2" --arg ip "$3" --argjson ttl "$4" \
    '{Comment: "cloudalbum dns ip-change-drill", Changes: [{Action: "UPSERT", ResourceRecordSet: {Name: $name, Type: "A", TTL: $ttl, ResourceRecords: [{Value: $ip}]}}]}')
  aws route53 change-resource-record-sets --hosted-zone-id "$1" --change-batch "$batch" --query ChangeInfo.Id --output text
}

case "$action" in
  swap)
    [ -f "$STATE" ] && { echo "a drill is still recorded in $STATE: run restore first" >&2; exit 2; }
    instance=$(output "cloudalbum-${ENV_NAME}-ec2" InstanceId)
    [ -n "$instance" ] || { echo '{"error":"InstanceId not found in cloudalbum-'"$ENV_NAME"'-ec2"}'; exit 1; }
    read -r old_alloc old_ip < <(aws ec2 describe-addresses --filters "Name=instance-id,Values=$instance" \
      --query 'Addresses[0].[AllocationId,PublicIp]' --output text)
    [ "$old_alloc" != None ] && [ -n "$old_alloc" ] || { echo '{"error":"the instance has no EIP (AssociateEip=true is required)"}'; exit 1; }
    read -r new_alloc new_ip < <(aws ec2 allocate-address --domain vpc \
      --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Project,Value=CloudAlbum},{Key=Env,Value=$ENV_NAME},{Key=Purpose,Value=dns-ip-change-drill}]" \
      --query '[AllocationId,PublicIp]' --output text)
    jq -n --arg i "$instance" --arg oa "$old_alloc" --arg oi "$old_ip" --arg na "$new_alloc" --arg ni "$new_ip" --arg at "$(date -u +%FT%TZ)" \
      '{instanceId: $i, oldAllocationId: $oa, oldIp: $oi, newAllocationId: $na, newIp: $ni, upserted: false, at: $at}' > "$STATE"
    aws ec2 associate-address --instance-id "$instance" --allocation-id "$new_alloc" --allow-reassociation >/dev/null
    if [ "$upsert" = 1 ]; then
      zone=$(output "cloudalbum-${ENV_NAME}-dns" EnvDnsHostedZoneId); record=$(output "cloudalbum-${ENV_NAME}-dns" EnvDnsRecordName)
      ttl=$(output "cloudalbum-${ENV_NAME}-dns" EnvDnsTtl); ttl=${ttl:-60}
      if [ -n "$zone" ] && [ -n "$record" ]; then
        upsert_record "$zone" "$record" "$new_ip" "$ttl" >/dev/null
        tmp=$(mktemp); jq --arg z "$zone" --arg r "$record" --argjson ttl "$ttl" '.upserted = true | .zoneId = $z | .record = $r | .ttl = $ttl' "$STATE" > "$tmp" && mv "$tmp" "$STATE"
      fi
    fi
    jq -c '. + {action: "swap"}' "$STATE" ;;
  restore)
    [ -f "$STATE" ] || { echo '{"action":"restore","note":"nothing to restore"}'; exit 0; }
    instance=$(jq -r .instanceId "$STATE"); old_alloc=$(jq -r .oldAllocationId "$STATE"); new_alloc=$(jq -r .newAllocationId "$STATE")
    aws ec2 associate-address --instance-id "$instance" --allocation-id "$old_alloc" --allow-reassociation >/dev/null
    if [ "$(jq -r .upserted "$STATE")" = true ]; then
      upsert_record "$(jq -r .zoneId "$STATE")" "$(jq -r .record "$STATE")" "$(jq -r .oldIp "$STATE")" "$(jq -r '.ttl // 60' "$STATE")" >/dev/null
    fi
    for _ in 1 2 3 4 5; do
      if aws ec2 release-address --allocation-id "$new_alloc" 2>/dev/null; then released=true; break; fi
      released=false; sleep 3
    done
    tmp=$(mktemp); jq --arg at "$(date -u +%FT%TZ)" --argjson rel "${released:-false}" '. + {restoredAt: $at, released: $rel, action: "restore"}' "$STATE" > "$tmp"
    cat "$tmp" | jq -c .; rm -f "$tmp" "$STATE"
    [ "${released:-false}" = true ] || { echo "release-address $new_alloc failed: release it in the console (unassociated EIPs are billed)" >&2; exit 1; } ;;
  status)
    if [ -f "$STATE" ]; then jq -c . "$STATE"; else echo '{"drill":"none"}'; fi ;;
  *) echo "usage: $0 swap [--upsert] | restore | status [--env <env>]" >&2; exit 64 ;;
esac
