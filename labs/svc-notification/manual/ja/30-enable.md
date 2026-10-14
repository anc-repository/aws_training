---
step: enable
---

SNS を組み込みます。モジュールはトピック `notification-events`、受信キュー `notification-inbox`（raw メッセージ配信、フィルターポリシーなし）、サブスクリプション単位の DLQ
`notification-dlq`、そして運用担当のフォールバック用メールアドレスへのメールサブスクリプション（フィルターポリシー `{"audience":["admin"]}`）を作成します。運用担当のメールアドレスには、あなたのメールアドレスの `+admin` エイリアスを使ってください。
たとえば通知用メールアドレスが `{{ learner.inputs.notify-email }}` なら、`@` の前に `+admin` を付けます。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable notification --param AdminEmail=<メールアドレスの +admin エイリアス> --no-migrate --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable notification --param AdminEmail=<メールアドレスの +admin エイリアス> --no-migrate
```
:::

`--no-migrate`：メール通知を有効にしているユーザーについては、次のステップで `subscribe-users.ts` を使って 1 人ずつサブスクリプションを作成します（移行スクリプトと同じ `subscribeEmail` を通ります）。

:::wait{typical=4 max=20}
トピックと 2 つのキューのデプロイには通常 1～2 分かかります。完了したら運用担当のメールボックスで「AWS Notification - Subscription Confirmation」を探し、**Confirm subscription** をクリックします。
確認するまで notification の状態は黄色の「运维订阅待确认」（運用担当のサブスクリプションが確認待ち）です。これは想定どおりの待機で、失敗ではありません。
:::

確認が済んだら、アプリのプレビューで `+u1` の写真にコメントを 1 件投稿し、そのリクエストのレスポンスヘッダーを確認します。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.notification | {driver, status, detail}'
```

:::why
**なぜメールのサブスクリプションには確認が必要なのでしょうか？** 誰でも他人のアドレスを自分のトピックにサブスクライブできてしまいます。受信者が確認リンクをクリックして初めて、SNS は配信を始めます。
これは、登録時の確認コードのようなトランザクションメールに SNS が向かない理由の 1 つでもあります（送信者は AWS Notifications で、プレーンテキストしか送れず、すべてのメールに配信停止のフッターが付きます）。
:::

::console-link[SQS コンソールで受信キューを開く]{link=sqs.queue queueUrlEncoded="{{ var.inboxUrl | url }}"}

:::expected
notification は「正常」で、detail は `主题 cloudalbum-…-notification-events · 已确认订阅 2 · 待确认 0 · 收件队列 0 · 订阅级 DLQ 0` のような形です。
コメントのリクエストの経路ヘッダーに `notification=sns:published` が含まれます。受信キューのアクセスポリシーは、このトピック（`aws:SourceArn`）から `sns.amazonaws.com` として送信することだけを許可しています。
:::

:::saa{domain=secure confusable="主题策略 vs 队列策略"}
SNS が SQS に配信するとき、書き込み権限は**キューポリシー**で `sns.amazonaws.com` に付与し、`aws:SourceArn` でどのトピックかを限定します（混乱した代理問題の防止）。
トピックポリシーは、誰がトピックに発行できるかを決めます。キューを CMK で暗号化している場合はキーポリシーでも `sns.amazonaws.com` を許可する必要があり、そうしないと配信は通知なしに失敗します。
:::

::checks
