---
step: worker-stop
---

worker が停止するとどうなるでしょうか？ランナーは 5 秒ごとにコメントを投稿し、5 秒目にプラットフォームの管理チャネル（SSM）で `cloudalbum-worker` を停止し、50 秒目に再び起動します。
その間の受信キューの深さと、`sqs-copy` の配信記録がそろっていく様子を記録します。

```bash {runsOn=workstation}
npm run exp -- notification --label after --scenario worker-stop --fault-via ssm --instance-id {{ target.instanceId }} --upload
```

::experiment{module=notification id=worker-stop label=after}

実行中に、別のワークベンチのターミナルで受信キューを確認できます。

```bash {runsOn=workstation}
aws sqs get-queue-attributes --queue-url "{{ var.inboxUrl }}" --attribute-names ApproximateNumberOfMessages
```

終わったら、worker が復旧していることを確認します。

```bash {runsOn=lab}
systemctl is-active cloudalbum-worker
```

最後に、メールボックスで 2 通のメールを並べて見比べます。1 通はこのステップの「コメント通知」（SNS 経由）、もう 1 通はステップ 3 の「確認コード / パスワードの再設定」（SES 経由）です。
送信者、本文の形式、メールの下部を比べてください。

:::expected
コメントはいつもどおり成功し（Publish は api プロセスで行われ、worker とは関係ありません）、通知メールもいつもどおり届きます。停止中は受信キューが滞留し、worker が起動すると消費され、
`/api/admin/notifications/deliveries` の `sqs-copy` の記録がそろいます。`systemctl is-active` は `active` を出力します。
:::

:::tip
使える配信チャネルがないときは `--fault-via skip` で実行し、表示に従ってラボ用インスタンスのターミナルで `sudo systemctl stop cloudalbum-worker` と `sudo systemctl start cloudalbum-worker` を手動で実行してください。
:::

::checks
