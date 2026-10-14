---
step: filter
---

`+u1` にだけイベントを 1 件送り、フィルターポリシーの効果を確認します。ランナーが u1 の写真にコメントを 1 件投稿し（メッセージ属性 `userId=<u1 の ID>`）、その後サーバーからこのイベントの配信記録を読み取ります。

```bash {runsOn=workstation}
npm run exp -- notification --label after --scenario filter --param user=u1 --upload
```

::experiment{module=notification id=filter label=after}

メールボックスで確かめます。このイベントでは受信者が `+u1` のメールだけが届き、`+u2` には届きません（すべてのエイリアスは同じメールボックスに届くので、受信者のアドレスで区別します）。

:::wait{typical=3 max=10}
SNS の CloudWatch メトリクスには分単位の遅延があります。`NumberOfNotificationsFilteredOut` は通常数分後に現れます。
:::

:::expected
filter の `emailedOthers` は 0 で、サーバー側には `sns` が 1 行と `sqs-copy` が 1 行だけあります（受信キューにはフィルターポリシーがないため、すべてのイベントを受け取ります）。
CloudWatch のこのトピックの `NumberOfNotificationsFilteredOut` が 0 より大きくなります。
:::

:::saa{domain=resilient confusable="SNS 过滤策略 vs 应用代码判断"}
フィルタリングは SNS 側で配信の前に行われ、アプリのコードを変える必要はありません。範囲はメッセージ属性（既定）かメッセージ本文（`FilterPolicyScope=MessageBody`）にできます。
順序と重複排除が必要なときは、SNS FIFO トピック + SQS FIFO キューを使います。
:::

::checks
