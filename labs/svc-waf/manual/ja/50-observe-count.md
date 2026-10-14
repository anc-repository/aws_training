---
step: observe-count
---

Count モードで誤検知を観察します。`false-positive` は管理者として CloudFront 経由で**正当だが怪しい**リクエストを 2 つ送ります。8 KB を超える大きなリクエストボディと、`SELECT * FROM` を含む普通のテキストです。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario false-positive
```

**us-east-1** の CloudWatch Logs Insights（ロググループ `{{ var.logGroup }}`）で、どのルールが一致したかを確認します。

```sql
stats count() by terminatingRuleId, action
```

ポイント：CRS の `SizeRestrictions_BODY`（8 KB）は写真のアップロードを誤ってブロックするため、このモジュールはこれを **Count に上書き**しています（ブロックせず、カウントだけ）。そのため大きなリクエストボディは通過するはずです。
