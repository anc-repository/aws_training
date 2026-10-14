---
step: failover
---

（任意）ルーティングポリシーをフェイルオーバーに変えます。PRIMARY ＝ラボ用インスタンスの EIP ＋ヘルスチェック（`origin.<ドメイン>/api/health/ready?scope=instance` を確認）、
SECONDARY ＝レコードと同じ名前の S3 静的ウェブサイトバケットにあるメンテナンスページです。

```bash {runsOn=workstation}
scripts/module enable dns --domain {{ learner.inputs.domain }} --target eip --param RoutingPolicy=failover
```

:::why
S3 のウェブサイトエンドポイントは Host ヘッダーでバケットを探すため、バケット名はレコード名と完全に同じでなければならず、HTTP しか使えません。サイトがすでに HTTPS を強制している場合は、DNS の層ではなく CDN の層で、
CloudFront のオリジングループを使ってフェイルオーバーするべきです。ヘルスチェックのメトリクスとアラームは us-east-1 にしかありません。
:::

訓練を実行します。10 秒目にラボ用インスタンスの Nginx を停止し、終了時に元に戻します。

```bash {runsOn=workstation}
npm run exp -- dns --label after --scenario failover-drill --fault-via ssm --upload
```

::experiment{module=dns id=failover-drill label=after}

:::expected
`marks` に順番に `unhealthy`（ヘルスチェックが異常になった）、`secondaryAnswer`（パブリックリゾルバーがメンテナンスページのバケットのアドレスを返した）、`maintenanceOk` が現れます。
合計で数十秒から数分です。終わったらルーティングポリシーを `simple` に戻します（`--param RoutingPolicy=simple`）。
:::

::checks
