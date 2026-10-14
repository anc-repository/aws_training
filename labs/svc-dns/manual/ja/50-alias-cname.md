---
step: alias-cname
---

このカードの宛先は EIP（通常の A レコード）なので、既存の Alias はありません。自分で 1 つ作ります。`www.<ドメイン>` → `<ドメイン>` への Alias です
（Alias は同じホストゾーン内のレコードを指すことができます）。

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
`dig` は A レコード（`{{ target.publicIp }}`）を直接返し、CNAME の連鎖はありません。Alias は Route 53 の内部で解決されるため、クライアントから見ればただの A レコードです。
:::

次に、**ゾーンの頂点**（ホストゾーンと同じ名前）に CNAME を作ってみます。

```bash {runsOn=workstation}
APEX=$(aws route53 get-hosted-zone --id {{ var.hostedZoneId }} --query HostedZone.Name --output text)
aws route53 change-resource-record-sets --hosted-zone-id {{ var.hostedZoneId }} --change-batch \
  "{\"Changes\":[{\"Action\":\"CREATE\",\"ResourceRecordSet\":{\"Name\":\"$APEX\",\"Type\":\"CNAME\",\"TTL\":60,\"ResourceRecords\":[{\"Value\":\"example.net\"}]}}]}"
```

:::expected
Route 53 はこの変更を拒否します（ゾーンの頂点にはすでに SOA と NS のレコードがあり、CNAME は置けません。具体的なエラーは実際の出力を確認してください）。ルートドメインを ALB / CloudFront に向けるには Alias しか使えません。
:::

:::warning
終了前に、手動で作った `www` のレコードを削除してください（上のコマンドの `UPSERT` を `DELETE` に変えてもう一度実行します）。このレコードは dns スタックに含まれないため、回収処理は CloudTrail のイベントからしか特定できません。
:::

::checks
