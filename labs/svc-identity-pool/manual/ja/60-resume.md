---
step: resume
---

再開可能なアップロードです。24 MB のファイル（3 パート）をアップロードし、2 つ目のパートの前で中断してから再開します。

```bash {runsOn=workstation}
npm run exp -- identity-pool --label after --scenario resume --upload
```

本当にネットワークを切ってみたい場合は、`--param pauseSec=30` を付け、スクリプトに「模拟断网」（ネットワーク切断を再現）と表示されたらワークベンチのネットワークを切断し、数秒後に戻してください。

::experiment{module=identity-pool id=resume label=after}

:::expected
`totalParts=3`、`partsBeforeInterruption=1`、`partsResent=2`、`onlyMissingResent=true` です。サーバー側の証拠 `partsReportedBeforeResume=1`
は S3 の `ListParts` から得たもので、complete の後、写真はサーバー側で `PROCESSING` / `READY` になります。
:::

:::tip
大きなファイルのアップロードは、認証情報の有効期間を超えることがあります。ブラウザーは認証情報の残りが 5 分を切ると `/api/uploads/credentials` にもう一度リクエストし、パートで `ExpiredToken`
が返ったときは更新してから 1 回だけ再試行します。完了しなかったマルチパートアップロードは、ステージングバケットのライフサイクルルールにより 1 日後に自動で中止されます。
:::

::checks
