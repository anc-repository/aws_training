---
step: alias-cname
---

This card's target is an EIP (a plain A record), so there is no Alias yet. Create one yourself: `www.<domain>` → Alias to `<domain>`
(an Alias can point at a record in the same hosted zone).

:::method{kind=cli default}
```bash {runsOn=workstation}
ZONE={{ var.hostedZoneId }}
cat > /tmp/alias.json <<EOF
{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"www.{{ learner.inputs.domain }}","Type":"A",
  "AliasTarget":{"HostedZoneId":"$ZONE","DNSName":"{{ learner.inputs.domain }}","EvaluateTargetHealth":false}}}]}
EOF
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE" --change-batch file:///tmp/alias.json
dig www.{{ learner.inputs.domain }} @8.8.8.8 | grep -A2 'ANSWER SECTION'
```
:::

:::expected
`dig` returns the A record (`{{ target.publicIp }}`) directly, with no CNAME chain — an Alias is resolved inside Route 53, so to the client it is just an A record.
:::

Now try to create a CNAME at the **zone apex** (the name that equals the hosted zone):

```bash {runsOn=workstation}
APEX=$(aws route53 get-hosted-zone --id {{ var.hostedZoneId }} --query HostedZone.Name --output text)
aws route53 change-resource-record-sets --hosted-zone-id {{ var.hostedZoneId }} --change-batch \
  "{\"Changes\":[{\"Action\":\"CREATE\",\"ResourceRecordSet\":{\"Name\":\"$APEX\",\"Type\":\"CNAME\",\"TTL\":60,\"ResourceRecords\":[{\"Value\":\"example.net\"}]}}]}"
```

:::expected
Route 53 rejects the change (the zone apex already has SOA and NS records and cannot also have a CNAME; check the actual output for the exact error). Pointing a root domain at an ALB / CloudFront only works with an Alias.
:::

:::warning
Before you end, delete the hand-made `www` record (change `UPSERT` to `DELETE` above and run it again): it is not in the dns stack, so the reclaimer can only find it through CloudTrail events.
:::

::checks
