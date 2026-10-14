---
step: enable
---

SES を組み込みます。モジュールは、メールアドレス ID `{{ learner.inputs.ses-identity }}`（すでにあれば読み取り専用で利用）、設定セット（評価メトリクス、設定セットレベルの BOUNCE / COMPLAINT の抑制）、
イベントトピックとフィードバックキュー（＋ DLQ）、`category` タグをディメンションとする CloudWatch のイベント送信先、そしてこの ID からの送信だけを許可するカスタマー管理ポリシー
（`ses:SendEmail` を `ses:FromAddress` 条件で限定）を作成します。

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
スタックのデプロイが終わると、スクリプトは 15 秒ごとに ID の状態を照会します。メールボックスで「Amazon Web Services – Email Address Verification Request」を探してリンクをクリックしてください。
スクリプトは「検証済み」を確認してから env を書き込み、プロセスを再起動し、SES メールボックスシミュレーターにプローブ用のメールを 1 通送ります。15 分以内に検証されないと終了コード 5 で終わります（スタックは残ります）。
検証した後で同じコマンドをもう一度実行してください。
:::

検証が終わったら、アプリのプレビューで `success+demo@simulator.amazonses.com` を使って新しいユーザーを登録します（SES メールボックスシミュレーターはサンドボックスでも受信できます）。
それから capabilities の状態を見ます。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.email | {driver, status, detail}'
```

::console-link[SQS コンソールでフィードバックキューを開く]{link=sqs.queue queueUrlEncoded="{{ var.feedbackUrl | url }}"}

:::expected
email のドライバーは `ses` です。サンドボックス中の状態は黄色で、detail は「沙盒：只能发给已验证地址 · 今日已发 n / 上限 m」（サンドボックス：検証済みのアドレスにのみ送信可能 · 本日の送信数 n / 上限 m）で始まります（上限は `GetAccount` から取得）。
これは想定どおりで、故障ではありません。登録リクエストの経路ヘッダーには `email=ses:sent` があります。
:::

:::saa{domain=secure confusable="SES 沙盒 vs 生产访问"}
新しいアカウントの SES はリージョン単位でサンドボックスにあります。検証済みのアドレス、ドメイン、メールボックスシミュレーターにしか送信できず、送信量も送信レートもかなり低く制限されています。本番アクセスは別途申請し、人による審査を受けます。
リージョンを変える場合は申請し直す必要があります。
:::

::checks
