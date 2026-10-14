---
step: port-forward
---

ポートフォワーディング：ワークベンチの 13000 番ポートをラボ用インスタンスの `127.0.0.1:3000`（api プロセス）に転送します。3000 番ポートを開ける必要も、踏み台サーバーも要りません。

```bash {runsOn=workstation}
aws ssm start-session --target {{ target.instanceId }} \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3000"],"localPortNumber":["13000"]}'
```

これを実行したまま、別のワークベンチのターミナルで次を実行し、出力をチェックに貼り付けます。

```bash {runsOn=workstation}
curl -s -o /dev/null -w '{"status":%{http_code}}' http://localhost:13000/api/health/ready
```

:::expected
`{"status":200}` が出力されます。終わったら、ポートフォワーディングのターミナルで Ctrl+C を押します。
:::

:::tip
データベースがプライベートサブネットにある場合（database=rds）は、`AWS-StartPortForwardingSessionToRemoteHost` でこのインスタンス経由で RDS エンドポイントに転送します。「一時的に 5432 を運用 IP に開ける」やり方の代わりになります。
ポートフォワーディングのセッションは転送した内容を記録しません。
:::

::checks
