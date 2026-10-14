---
step: enable
---

ElastiCache を組み込みます。モジュールはデフォルト VPC にサブネットグループ、`sg-cache`（6379 はラボ用インスタンスのセキュリティグループだけを許可）、単一ノードのレプリケーショングループ（`cache.t4g.micro`、転送時と保管時の暗号化を有効化）を作成し、
`REDIS_URL` を書き込んで api を再起動した後、SET / GET / DEL のプローブで利用できることを確認します。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable cache --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable cache
```
:::

:::wait{typical=10 max=25}
レプリケーショングループの作成には通常 10 分ほどかかります。待っている間に、Valkey / Redis OSS と Memcached の違い（このステップの最後）を読んでおきましょう。
:::

:::expected
cache の状態は「正常」です。タイムラインを 2 回続けて再読み込みすると、2 回目の経路ヘッダーに `cache=redis@elasticache:hit` が現れ、パフォーマンスバッジに「ElastiCache HIT」と表示されます。
:::

:::saa{domain=cost confusable="Valkey / Redis OSS vs Memcached"}
ノードベースの Memcached はマルチスレッドで、レプリケーションも永続化もありません。Valkey / Redis OSS はレプリカ、マルチ AZ の自動フェイルオーバー（レプリカが 1 つ以上必要）、スナップショットに対応します。
Serverless はストレージと ECPU で課金され、最低ストレージ課金量があります。ノードモードはノード時間で課金されます。
:::

::checks
