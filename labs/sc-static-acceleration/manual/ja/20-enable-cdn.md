---
step: enable-cdn
---

ディストリビューションを作成し、メディアのオリジンを S3 にします。`scripts/module` は 3 段階で行います。EC2 をオリジンにしてディストリビューションをデプロイ（キャッシュポリシー、レスポンスヘッダーポリシー、`/media` プレフィックスを取り除く CloudFront Function、
8080 のオリジンリスナーとセキュリティグループを含む）→ ディストリビューションの ARN を storage スタックに注入して OAC のバケットポリシーを生成 → `/media/*` のビヘイビアのオリジンを S3 に切り替え。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_MEDIA_ORIGIN=s3 --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_MEDIA_ORIGIN=s3
```
:::

:::wait{typical=8 max=25}
ディストリビューションの状態が「デプロイ中」から「有効」になるまで数分かかります。3 段階の間にディストリビューションは 2 回更新されます。
:::

コンソールでビヘイビア、キャッシュポリシー、オリジンを見比べます。

::console-link[ディストリビューションを開く]{link=cloudfront.distribution distributionId="{{ var.distributionId }}"}

:::expected
cdn の状態が「正常」です。`/media/*` のビヘイビアのオリジンは `s3-media`（OAC 付き）で、その他のビヘイビアはラボ用インスタンスにオリジンリクエストします。ディストリビューション経由で `/api/health/live` にリクエストすると、経路ヘッダーは `entry=cloudfront>nginx` で始まります。
:::

:::saa{domain=performance confusable="缓存策略 vs 源请求策略"}
キャッシュポリシーはキャッシュキーと TTL を決めます。オリジンリクエストポリシーは、オリジンリクエスト時に追加で送るヘッダー、Cookie、クエリパラメーターを決めます（キャッシュキーには入りません）。レスポンスヘッダーポリシーは、エッジでレスポンスにヘッダー（CORS、セキュリティヘッダー）を追加します。
:::

::checks
