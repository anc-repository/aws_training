---
step: worker-stop
---

worker が停止するとどうなるでしょうか？ラボ用インスタンスのターミナルで worker を停止します。

```bash {runsOn=lab}
sudo systemctl stop cloudalbum-worker
```

アプリのプレビューでテストユーザーの写真にコメントをいくつか投稿し、受信キューを確認します。

```bash {runsOn=workstation}
aws sqs get-queue-attributes --queue-url "{{ var.inboxUrl }}" --attribute-names ApproximateNumberOfMessages
```

メールボックスでこれらのコメントの通知メールを確認したら、worker を再び起動します。

```bash {runsOn=lab}
sudo systemctl start cloudalbum-worker
```

:::expected
コメントはいつもどおり成功し（Publish は api プロセスで行われ、worker とは関係ありません）、通知メールもいつもどおり届きます。滞留するのは受信キューだけで、worker が起動すると消費され、
`/api/admin/notifications/deliveries` の `sqs-copy` の記録がそろいます。
:::

:::tip
停止と復旧をランナーに自動で行わせることもできます：`npm run exp -- notification --label after --scenario worker-stop --fault-via ssm --instance-id {{ target.instanceId }}`
（5 秒目に worker を停止し、50 秒目に起動して、その間の受信キューの深さを記録します）。
:::

::checks
