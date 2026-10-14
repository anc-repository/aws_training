---
step: orient
---

まずローカルの一覧を見ます。右側の「アプリのプレビュー」で `/lab` を開くと、トップバーの左側に「当前按小时计费的资源：EC2 实例 ×1、公网 IPv4 ×1（已启用 … 小时）；
未填写 cost-rates.yaml，不显示金额」（現在の時間課金リソース：EC2 インスタンス ×1、パブリック IPv4 ×1（有効化から … 時間）。cost-rates.yaml が未入力のため金額は表示しません）と書かれています。ラボ用インスタンスで直接確認することもできます。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.cost | {driver, status, localHealth, detail}'
```

:::expected
`driver` は `local`、`status` は `off` で、detail には EC2 インスタンスとパブリック IPv4 が並んでいます。一覧にワークベンチとプラットフォームのリソースは**ありません**。これらはこのプロジェクトが
scripts/module で有効にしたモジュールではないからです。
:::

:::saa{domain=cost confusable="按小时计费 vs 按用量计费"}
パブリック IPv4、NAT Gateway、Interface Endpoint、RDS、ElastiCache のノードは、どれも「動いている限り時間課金」です。データ転送（アウト）やリクエスト数は従量課金で、ローカルの一覧には「本机无法估算」（このホストでは見積もれない）としか書けません。
:::

::checks
