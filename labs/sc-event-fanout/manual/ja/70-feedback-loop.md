---
step: feedback-loop
---

（任意）SES のメールボックスシミュレーターで、バウンスと苦情が戻ってくる流れを演習します。シミュレーターのアドレスはサンドボックスでも受信でき、アカウントの評価のメトリクスにも影響しません。

アプリのプレビューでログアウトし、次の 2 つのアドレスでそれぞれユーザーを 1 人ずつ登録します（登録 API は IP ごとに 10 分間で 20 回まで）。

```text
bounce@simulator.amazonses.com
complaint@simulator.amazonses.com
```

その後、管理者として `/admin/outbox` を開き、この 2 通の確認メールの配信状態が更新されるのを待ちます。同時に、フィードバックキューとその DLQ も確認します。

```bash {runsOn=workstation}
aws sqs get-queue-attributes --queue-url "{{ var.feedbackUrl }}" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
aws sqs get-queue-attributes --queue-url "{{ var.feedbackDlqUrl }}" --attribute-names ApproximateNumberOfMessages
```

:::expected
数秒から数分で、bounce の行は「退信」（バウンス）に、complaint の行は「投诉」（苦情）に変わります。`bounce@…` のユーザーの `email_status` は `bounced` になり、
以後このユーザーには確認とパスワードの再設定という 2 種類の必須メールだけが送られます。フィードバックキューは worker に消費されて 0 になり、フィードバック DLQ は 0 です。
:::

:::why
イベントの経路は、SES の設定セットのイベント送信先 → SNS のイベントトピック → SQS のフィードバックキュー → worker です。worker が解析できないメッセージは 5 回受信された後にフィードバック DLQ に入ります。
設定セット単位とアカウント単位の抑制リストが、2 つ目の防御になります。
:::

::checks
