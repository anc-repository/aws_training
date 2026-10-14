---
step: alias-cname
---

本卡的目标是 EIP（普通 A 记录），没有现成的 Alias。自己建一条：`www.<域名>` → Alias 到 `<域名>`
（Alias 可以指向同一托管区域中的记录）。

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
`dig` 直接返回 A 记录（`{{ target.publicIp }}`），没有 CNAME 链——Alias 在 Route 53 内部解析，对客户端来说就是一条 A 记录。
:::

再试着为**区域顶点**（与托管区域同名的名字）建一条 CNAME：

```bash {runsOn=workstation}
APEX=$(aws route53 get-hosted-zone --id {{ var.hostedZoneId }} --query HostedZone.Name --output text)
aws route53 change-resource-record-sets --hosted-zone-id {{ var.hostedZoneId }} --change-batch \
  "{\"Changes\":[{\"Action\":\"CREATE\",\"ResourceRecordSet\":{\"Name\":\"$APEX\",\"Type\":\"CNAME\",\"TTL\":60,\"ResourceRecords\":[{\"Value\":\"example.net\"}]}}]}"
```

:::expected
Route 53 拒绝这次修改（区域顶点已经有 SOA 与 NS 记录，不能再有 CNAME；具体报错以实际输出为准）。根域名指向 ALB / CloudFront 时只能用 Alias。
:::

:::warning
结束前删掉 `www` 这条手工记录（把上面的 `UPSERT` 改成 `DELETE` 再执行一次）：它不在 dns 栈里，回收器只能按 CloudTrail 事件认领。
:::

::checks
