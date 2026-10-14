---
step: enable-cdn
---

ラボ用インスタンスの前に CloudFront ディストリビューションを作り、同じ有効化の中で**直接アクセスの入口をロック**します。80/443 は管理者 IP、つまりワークベンチのパブリックな送信元
`{{ workstation.publicIp }}` にだけ開きます。CloudFront はラボ用インスタンスの 8080 のオリジンリスナーにオリジンリクエストし、このリスナーは CloudFront のマネージドプレフィックスリストだけを許可します。さらに Nginx が、
このディストリビューションしか知らない `X-Origin-Verify` リクエストヘッダーを検証します。

:::why
**なぜ後で締めるのではなく、ディストリビューションを作るときにロックするのでしょうか？** このカードの目標は「すべてのトラフィックがエッジの防御を通らなければならない」ことです。直接アクセスの入口が開いていれば、後で付けた WAF は迂回されてしまいます
（DEP-018）。管理者 IP に直接アクセスを残すのは、運用のためと、ステップ 8、9 で「直接アクセス vs エッジ」を並べて比較するためです。
:::

:::method{kind=script default}
まず変更内容をプレビューします（cdn スタック、オリジンのセキュリティグループ、そして ec2 の基盤スタックの `PublicHttpIngress=admin-ip`）。

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR={{ workstation.publicIp }}/32 --dry-run
```

内容を確認したら実行します（スクリプトはオリジン用のシークレットを生成し、8080 のリスナーを配置し、ディストリビューションをデプロイしてデプロイ完了を待ちます）。

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR={{ workstation.publicIp }}/32
```
:::

:::tip
`--param` ではなく `--set`（cdn が所有する `CDN_*` キーに書き込む）を使います。`CDN_DIRECT_ACCESS=admin-ip` を指定して `CDN_ADMIN_CIDR` を指定しないと、スクリプトは終了コード 2 で実行を拒否します。
:::

:::wait{typical=6 max=20}
ディストリビューションの状態が「デプロイ中」から「有効」になるまで数分かかります。デプロイ中もアプリのプレビューでアルバムを見続けられます。ロックが有効になると、プレビューはディストリビューションのドメイン名に切り替わります。
:::

::console-link[このセッションのディストリビューションを開く]{link=cloudfront.distribution distributionId="{{ var.distributionId }}"}

:::expected
cdn の状態が「正常」です。ディストリビューション経由で `/api/health/live` にリクエストすると、経路ヘッダーは `entry=cloudfront>nginx` で始まります。オリジンは `{{ target.publicDns }}:8080` で、
HTTP のみ、`X-Origin-Verify` ヘッダー付きです。
:::

::checks
