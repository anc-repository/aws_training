---
step: enable-notification
---

SNS を組み込みます。モジュールはトピック `notification-events`、受信キュー `notification-inbox`（raw メッセージ配信、フィルターポリシーなし）、サブスクリプション単位の DLQ
`notification-dlq`、そして運用担当のフォールバック用メールアドレスへのメールサブスクリプション（フィルターポリシー `{"audience":["admin"]}`）を作成します。運用担当のメールアドレスには、通知用メールアドレスの `+admin` エイリアスを使ってください。
たとえば通知用メールアドレスが `{{ learner.inputs.notify-email }}` なら、`@` の前に `+admin` を付けます。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable notification --param AdminEmail=<通知用メールアドレスの +admin エイリアス> --no-migrate --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable notification --param AdminEmail=<通知用メールアドレスの +admin エイリアス> --no-migrate
```
:::

`--no-migrate`：移行フレームワークはまだ導入されていません。2 人のテストユーザーのサブスクリプションは次のスクリプトで作成します（移行スクリプトと同じ `subscribeEmail` を通ります）。
スクリプトは各ユーザーとして「メール通知」をもう一度有効にし、それによって sns ドライバーが `Subscribe` を呼び出します。プロトコルは `email`、フィルターポリシーは `{"userId":["<そのユーザーの ID>"]}` です。

```bash {runsOn=workstation}
npx tsx experiments/notification/subscribe-users.ts
```

:::wait{typical=5 max=20}
確認メールは合計 3 通です（受信者はそれぞれ `+admin`、`+u1`、`+u2`）。1 つずつ **Confirm subscription** をクリックします。確認するまで、notification の状態は黄色の
「运维订阅待确认」（運用担当のサブスクリプションが確認待ち）です。これは想定どおりの待機で、失敗ではありません。worker は 5 分ごとにサブスクリプションの状態を同期します。
:::

すべて確認したら、アプリのプレビューで `+u1` の写真にコメントを 1 件投稿し、SNS コンソールでトピック `cloudalbum-{{ session.env }}-notification-events` の「サブスクリプション」ページを開き、
`+u1` のサブスクリプションをクリックして「サブスクリプションフィルターポリシー」を確認します。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.notification | {driver, status, detail}'
```

::console-link[SQS コンソールで受信キューを開く]{link=sqs.queue queueUrlEncoded="{{ var.inboxUrl | url }}"}

:::expected
notification は「正常」です。コメントのリクエストの経路ヘッダーに `notification=sns:published` が含まれます。トピックには受信キューの sqs サブスクリプションと、確認済みのメールサブスクリプションが少なくとも 3 つあります。
受信キューのアクセスポリシーは、このトピック（`aws:SourceArn`）から `sns.amazonaws.com` として送信することだけを許可しています。
:::

:::why
**なぜメールのサブスクリプションには確認が必要なのでしょうか？** 誰でも他人のアドレスを自分のトピックにサブスクライブできてしまいます。受信者が確認リンクをクリックして初めて、SNS は配信を始めます。
**フィルターポリシーは既定でメッセージ属性を照合します**。発行時に `userId` 属性を付け忘れると、フィルターポリシーを持つサブスクリプションはどれも受け取れません。逆に、フィルターポリシーの**ない**メールサブスクリプションはトピックのすべてのメッセージを受け取ります。
ユーザーをトピックにサブスクライブしたのにフィルターポリシーを付け忘れると、そのユーザーに全員のコメント通知が届いてしまいます。これはプライバシー事故です。
:::

::checks
