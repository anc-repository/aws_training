---
step: after
---

after を記録します。同じ 20 件のコメントで、今回はイベントごとに `Publish` が 1 回だけです。

```bash {runsOn=workstation}
npm run exp -- notification --label after --scenario fanout --upload
npm run exp:report -- notification
```

::experiment{module=notification id=fanout label=after}

:::expected
レポートの配信チャネルは、before が `email`、after が `sns` + `sqs-copy`（イベントごとに各 1 行）です。after の `notification` 区間は 1 回の Publish の所要時間で、
サブスクライバーの数とは関係ありません。メールボックスの通知メールは送信者が AWS Notifications のプレーンテキストで、下部に配信停止リンクがあります。
:::

:::tip
機能比較（参考）：`npm run exp -- notification --label after --scenario compare` は `POST /api/lab/notification/compare` を呼び出し、
同じ `report.ready` テストイベントを db ドライバーと sns ドライバーでそれぞれ 1 回ずつ送って、所要時間と呼び出し回数を並べて表示します（エンドポイントは統合段階で登録されます。404 が返った場合はスキップします）。
:::

::checks
