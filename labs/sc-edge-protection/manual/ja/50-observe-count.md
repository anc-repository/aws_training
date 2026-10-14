---
step: observe-count
---

マネージドルールグループを新しく有効にするときは、まず Count にし、実際のトラフィックの COUNT の記録を読み、誤検知がないことを確認してから Block に変えます。`false-positive` は管理者として CloudFront 経由で
**正当だが怪しい**リクエストを 2 つ送ります。8 KB を超えるリクエストボディと、`SELECT * FROM` を含む普通のテキストです。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario false-positive --upload
```

::experiment{module=waf id=false-positive label=after}

さらに、アプリのプレビューで写真を 1 枚アップロードします（`storage` はローカルのままなので、写真は `/api/storage/upload` に大きなリクエストボディでアップロードされます）。その後 **us-east-1** の
CloudWatch Logs Insights でロググループ `{{ var.logGroup }}` を選び、どのルールが一致したかを確認します。

```sql
fields @timestamp, httpRequest.uri, action, terminatingRuleId
| sort @timestamp desc
| limit 50
```

モジュールはロググループに BLOCK と COUNT の記録だけを配信します。アップロードのリクエストの記録を展開し、`ruleGroupList` で `AWSManagedRulesCommonRuleSet` を探します。
一致した `SizeRestrictions_BODY` は「終了しない」一致ルールの中にあり、アクションは COUNT です。WAF コンソールの「サンプリングされたリクエスト」でルールごとに絞り込むこともできます。

:::expected
大きなリクエストボディも写真のアップロードも成功します。CRS の `SizeRestrictions_BODY` はテンプレートで**ルールアクションの上書き**により Count になっているので、カウントするだけでブロックしません。
SQL のキーワードを含む普通のテキストも、この時点ではカウントされるだけです（マネージドルールグループ全体がまだ Count なので）。
:::

:::why
**なぜ 1 つのルールだけを上書きするのでしょうか？** コアルールセット全体を削除すると、OWASP 系の防御をすべて手放すことになります。ルールアクションの上書き（またはアップロードのパスへのスコープダウンステートメント）なら、誤検知した 1 つだけを見逃し、
それ以外のルールは有効のままにできます。
:::

::checks
