---
step: orient
---

まず出発点を確認します。写真はラボ用インスタンスのデータボリュームに書き込まれ、アップロードのリクエストはラボ用インスタンス自身に送られます。

1. 右側の「アプリのプレビュー」で写真を 1 枚アップロードし、開発者ツールの Network パネルでアップロードのリクエストを探します。PUT の送信先はこのサイトの `/api/storage/upload` です。
2. ラボ用インスタンスのターミナルで、データボリュームの使用状況を確認します。

```bash {runsOn=lab}
df -h /var/lib/cloudalbum
sudo du -sh /var/lib/cloudalbum/uploads
```

:::expected
アップロードリクエストの `X-CloudAlbum-Path` に `storage=local:write` が含まれます。`/var/lib/cloudalbum/uploads` の下に、アップロードしたばかりの元画像があります。
:::

::checks
