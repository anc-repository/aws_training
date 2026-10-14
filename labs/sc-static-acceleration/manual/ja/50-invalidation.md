---
step: invalidation
---

キャッシュの代償は「更新がすぐには反映されない」ことです。このステップでは 2 つの更新方法を比べます。無効化を作成する方法と、新しいオブジェクトキーに変える方法（バージョン付きファイル名）です。

1. アルバムの `/lab` ページを開き、cdn カードの「覆盖同名缩略图」（同じ名前のサムネイルを上書き）をクリックします。CDN 経由で再読み込みしても古い画像のままです（`X-Cache: Hit`、`Age` が増えていく）。
2. 「创建失效」（無効化を作成）をクリックするか、ワークベンチのターミナルで自分で作成します。

```bash {runsOn=workstation}
aws cloudfront create-invalidation --distribution-id {{ var.distributionId }} --paths "/media/variants/*"
aws cloudfront list-invalidations --distribution-id {{ var.distributionId }} --query "InvalidationList.Items[].[Id,Status]" --output table
```

3. 無効化が `Completed` になったら再読み込みします。まず Miss になり、その後新しい画像が表示されます。
4. 次に「版本化键」（バージョン付きのキー）をクリックします。待つことなくすぐに新しい画像が表示され、無効化の枠も消費しません。

:::wait{typical=2 max=10}
無効化はすべてのエッジロケーションに伝わる必要があり、通常は数十秒から数分かかります。
:::

:::saa{domain=cost confusable="失效 vs 版本化文件名"}
頻繁にリリースする静的資産にはコンテンツのハッシュを含むファイル名を使い、`index.html` は `no-cache` かごく短い TTL にします。無効化は必要なときだけ使います。毎月の無料枠を超えた無効化パスには料金がかかります。
:::

::checks
