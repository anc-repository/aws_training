---
step: orient
---

まず出発点を確認します。今はすべてのコンテンツを EC2 の Nginx が直接返しており、レスポンスに CDN の痕跡はありません。

1. 右側の「アプリのプレビュー」でアルバムを開き、ブラウザーの開発者ツールの Network パネルで任意のサムネイルのレスポンスヘッダーを見ます。`X-CloudAlbum-Path` はありますが、`X-Cache` はありません。
2. ワークベンチのターミナルから、ラボ用インスタンスの Elastic IP に直接リクエストします。

```bash {runsOn=workstation}
curl -skI "https://{{ target.publicIp }}/" | grep -iE '^(x-cache|x-cloudalbum-path|server):'
```

:::expected
```text
x-cloudalbum-path: entry=nginx;inst={{ target.instanceId }};az={{ target.az }}
```
`x-cache` の行はなく、`entry` は `nginx` だけです。
:::

:::why
`X-CloudAlbum-Path` は CloudAlbum の経路ヘッダーで、`entry` にはリクエストが通った入口チェーンが記録されます。CloudFront を有効にすると `cloudfront>nginx` に変わります。
:::

::checks
