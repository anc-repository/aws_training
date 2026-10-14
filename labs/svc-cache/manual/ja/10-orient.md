---
step: orient
---

アプリのプレビューでタイムラインを開き、何度か再読み込みして、ページのパフォーマンスバッジとレスポンスヘッダーに注目します。

```bash {runsOn=lab}
curl -s -o /dev/null -D - "http://127.0.0.1/api/feed?limit=24" | grep -iE "^(x-cloudalbum-path|server-timing):"
```

:::expected
パフォーマンスバッジには「未缓存」（キャッシュなし）と表示されます。経路ヘッダーの cache セグメントは `none` で、`Server-Timing` の `database` 項目にはこのリクエストでデータベースに何回問い合わせたか（`xN`）が表示されます。
:::

::checks
