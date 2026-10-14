---
step: orient
---

まず出発点を確認します。ログはデータボリューム上のファイルにすぎず、このインスタンス 1 台分しかありません。

ラボ用インスタンスのターミナルで実行します。

```bash {runsOn=lab}
sudo ls -l /var/lib/cloudalbum/logs/
sudo tail -n 3 /var/lib/cloudalbum/logs/nginx-access.json | jq -c '{ts, rid, uri, status}'
curl -s http://127.0.0.1/api/capabilities | jq '.modules.logging | {driver, status, localHealth}'
```

:::expected
ディレクトリには `api.log`、`worker.log`、`nginx-access.json`（と logrotate がローテーションした `.1`、`.gz`）があり、所有者は `cloudalbum`、アクセス権は `0640` です。
logging のドライバーは `file`、状態は `off`（ローカル実装は正常）です。Nginx の `rid` はレスポンスヘッダー `X-CloudAlbum-Request-Id` と同じで、アプリのログでは `requestId` と呼ばれます。
:::

:::tip
想像してみてください。このインスタンスが明日置き換えられたら（たとえば Auto Scaling のスケールイン）、これらのファイルは残っているでしょうか？「過去 1 時間でどの API の 5xx が最も多いか」を調べるには、どんなコマンドを書きますか？
:::

::checks
