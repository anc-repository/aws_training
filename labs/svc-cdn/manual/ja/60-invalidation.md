---
step: invalidation
---

キャッシュの代償は「更新がすぐには反映されない」ことです。このステップでは 2 つの更新方法を比べます。無効化を作成する方法と、新しいオブジェクトキーに変える方法（バージョン付きファイル名）です。

1. アルバムの `/lab` ページを開き、cdn カードの「覆盖同名缩略图」（同名サムネイルの上書き）を押します。CDN 経由で再読み込みしても古い画像のまま（`X-Cache: Hit`、`Age` が増えていく）ですが、直接アクセスではすでに新しい画像です。
2. 「创建失效」（無効化を作成）を押すか、ワークベンチのターミナルで自分で作成します（パスは `/lab` ページに表示されたサムネイルに置き換えてください）。

```bash {runsOn=workstation}
aws cloudfront create-invalidation --distribution-id {{ var.distributionId }} --paths "/media/variants/*"
aws cloudfront list-invalidations --distribution-id {{ var.distributionId }} --query "InvalidationList.Items[].[Id,Status]" --output table
```

3. 無効化が `Completed` になったら再読み込みします。まず Miss になり、新しい画像が表示されます。
4. 次に「版本化键」（バージョン付きキー）を押します。新しい画像がすぐに表示され、待つ必要も無効化の無料枠を消費することもありません。

:::wait{typical=2 max=10}
無効化はすべてのエッジロケーションに伝播する必要があり、通常は数十秒から数分かかります。
:::

:::saa{domain=performance confusable="失效 vs 版本化文件名"}
頻繁にリリースする静的リソースにはコンテンツハッシュ付きのファイル名（バージョン付き）を使い、`index.html` には `no-cache` かごく短い TTL を設定します。無効化は必要なときだけ使います。毎月の無料枠を超えた無効化パスは課金されます。
:::

::checks
