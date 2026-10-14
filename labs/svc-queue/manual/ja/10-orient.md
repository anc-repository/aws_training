---
step: orient
---

まず出発点を確認します。ジョブは api プロセスのメモリ内キューに入り、サムネイルは worker プロセスが生成します。

1. 右側の「アプリのプレビュー」で写真を何枚かアップロードします。まず灰色のプレースホルダーが表示され、数秒後にサムネイルが現れます。
2. `/admin/jobs` を開きます。上部に「任务在 api 进程内存中排队（重启即丢）」（ジョブは api プロセスのメモリで待機中。再起動すると失われる）と表示されています。
3. ワークベンチのターミナルで、アップロードリクエストの経路ヘッダーを確認します。

```bash {runsOn=workstation}
curl -sk "https://{{ target.publicIp }}/api/capabilities" | jq '.modules | {queue: .queue.driver, imageProcessing: .["image-processing"].driver}'
```

:::expected
```json
{ "queue": "memory", "imageProcessing": "worker" }
```
アップロードリクエストの `X-CloudAlbum-Path` に `queue=memory:queued` が含まれます。
:::

::checks
