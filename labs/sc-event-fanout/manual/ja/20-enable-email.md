---
step: enable-email
---

SES を組み込みます。モジュールはメールアドレスの ID `{{ learner.inputs.ses-identity }}`（すでにある場合は読み取り専用で接続）、設定セット（評価のメトリクス、設定セット単位の BOUNCE / COMPLAINT の抑制）、
イベントトピックとフィードバックキュー（+ DLQ）、そしてこの ID からの送信だけを許可するカスタマー管理ポリシーを作成します。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable email --param Email={{ learner.inputs.ses-identity }} --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable email --param Email={{ learner.inputs.ses-identity }}
```
:::

:::wait{typical=5 max=20}
スタックのデプロイが終わると、スクリプトは 15 秒ごとに ID の状態を問い合わせます。メールボックスで「Amazon Web Services – Email Address Verification Request」を探し、リンクをクリックしてください。
スクリプトは「検証済み」を確認してから env を書き込み、プロセスを再起動します。15 分以内に検証されないと終了コード 5 で終わります（スタックは残ります）。検証した後で同じコマンドをもう一度実行してください。
:::

検証が終わったら、トランザクションメールを 1 通、**実際に**受信箱に届けてみます。アプリのプレビューでログアウトし、`{{ learner.inputs.ses-identity }}` で新しいユーザーを登録します
（このアドレスがすでに登録済みなら、ログインページの「忘记密码」（パスワードを忘れた場合）で再設定メールを送ります）。その後、機能の状態とアカウントのサンドボックスの状態を確認します。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.email | {driver, status, detail}'
```

```bash {runsOn=workstation}
aws sesv2 get-account --query "{production:ProductionAccessEnabled,quota:SendQuota}"
aws sns list-subscriptions-by-topic --topic-arn "{{ var.emailEventsTopicArn }}" --query "Subscriptions[].[Protocol,Endpoint]" --output table
```

::console-link[SQS コンソールでフィードバックキューを開く]{link=sqs.queue queueUrlEncoded="{{ var.feedbackUrl | url }}"}

:::expected
メールが受信箱に届き、登録リクエストの経路ヘッダーに `email=ses:sent` が含まれます。email のドライバーは `ses` で、サンドボックスでは状態が黄色になり、detail は「沙盒：只能发给已验证地址」（サンドボックス：検証済みのアドレスにしか送れない）で始まります。
これは想定どおりで、故障ではありません。`get-account` は `production: false` を示します。SES のイベントトピックのサブスクリプションは 1 つだけで、プロトコルは `sqs`、送信先は `cloudalbum-{{ session.env }}-email-feedback` です。
:::

:::why
**なぜバウンスをアプリに戻す必要があるのでしょうか？** バウンス率や苦情率が高すぎると、アカウントは審査を受けたり、送信を停止されたりします（しきい値は公式ドキュメントを確認してください）。設定セット → SNS → SQS によって、アプリはこれらのイベントを自分から取りに行けます。
ラボ用インスタンスは送信方向の接続を開始するだけで、受信ポートは不要です。worker の停止中、イベントはキューに残り、復旧後にいつもどおり処理されます。
:::

:::saa{domain=secure confusable="SES 沙盒 vs 生产访问"}
新しいアカウントの SES はリージョンごとにサンドボックスにあります。検証済みのアドレス、ドメイン、メールボックスシミュレーターにしか送れず、送信量もレートも低く抑えられています。本番アクセスは別途申請して人による審査を受ける必要があり、リージョンを変えると申請し直しになります。
:::

::checks
