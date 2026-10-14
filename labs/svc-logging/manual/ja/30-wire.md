---
step: wire
---

CloudWatch Logs を組み込みます。モジュールはロググループ `/cloudalbum/{{ session.env }}/app` と `/nginx`（保持期間 14 日）、メトリクスフィルター
`AppErrors`、`Nginx5xx`、`AuthLoginFailed`（名前空間 `CloudAlbum/Logs`）、4 つの保存済み Logs Insights クエリを作成し、インスタンスポリシーをアタッチしてから api と worker を再起動します。

:::method{kind=script default}
まず変更内容をプレビューします（`LOG_CW_SHIPPER=sdk`：アプリ自身がまとめて送信します）。

```bash {runsOn=workstation}
scripts/module enable logging --param RetentionInDays=14 --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable logging --param RetentionInDays=14
```
:::

:::wait{typical=3 max=10}
ロググループとメトリクスフィルターのデプロイは 1 分もかかりません。再起動後、送信機は 2 秒ごと（`LOG_CW_FLUSH_MS`）に 1 バッチ送信します。その後プラットフォームがラボ用インスタンスに 1 回リクエストし、このインスタンスの
`<インスタンス ID>/access` ログストリームが Nginx ロググループに現れたことを確認します。
:::

::console-link[CloudWatch コンソールで Nginx ロググループを開く]{link=logs.group logGroupEncoded="{{ var.nginxGroup | url }}"}

:::expected
logging のドライバーは `cloudwatch` で状態は正常、detail には「CloudWatch Logs · /cloudalbum/{{ session.env }}/app · 流 <实例 ID>/api …」（ストリーム <インスタンス ID>/api）と表示されます。
2 つのロググループの保持期間はどちらも 14 日です。ローカルファイルへの書き込みも続いています。
:::

:::saa{domain=cost confusable="保留期"}
ロググループはデフォルトでは**失効しない**ため、保存料金は増える一方です。必ず保持期間を設定してください。ログクラス（Standard / Infrequent Access）は作成後に変更できません。このモジュールでは Standard に統一しています。
:::

::checks
