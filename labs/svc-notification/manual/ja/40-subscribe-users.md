---
step: subscribe-users
---

テストユーザー 3 人にメールサブスクリプションを作成します。スクリプトは各ユーザーとして「メール通知」をもう一度有効にし（`PUT /api/notifications/prefs`）、
それによって sns ドライバーが `Subscribe` を呼び出します。プロトコルは `email`、`ReturnSubscriptionArn=true`、フィルターポリシーは `userId` で照合します（管理者には `audience=admin` も加えます）。
サブスクリプションの ARN と「確認待ち」の状態は `notification_prefs` に書き戻されます。

```bash {runsOn=workstation}
npx tsx experiments/notification/subscribe-users.ts
```

:::wait{typical=5 max=20}
各アドレスに AWS から確認メールが 1 通ずつ届くので（合計 3 通、受信者はそれぞれ `+u1`～`+u3`）、1 つずつ **Confirm subscription** をクリックします。
worker は 5 分ごとにサブスクリプションの状態を同期し、設定ページの「等待确认（请查收 AWS Notifications 的邮件）」（確認待ち。AWS Notifications からのメールを確認してください）はその後「已开启」（有効）に変わります。
:::

SNS コンソールでトピック `cloudalbum-{{ session.env }}-notification-events` の「サブスクリプション」ページを開き、`+u1` のサブスクリプションをクリックして「サブスクリプションフィルターポリシー」を確認します。

:::why
**フィルターポリシーは既定でメッセージ属性を照合します。** 発行時に `userId` 属性を付け忘れると、フィルターポリシーを持つサブスクリプションはどれも受け取れません。逆に、フィルターポリシーの**ない**メールサブスクリプションは
トピックのすべてのメッセージを受け取ります。ユーザーをトピックにサブスクライブしたのにフィルターポリシーを付け忘れると、そのユーザーに全員のコメント通知が届いてしまいます。これはプライバシー事故です。
:::

:::expected
トピックには少なくとも 5 つのサブスクリプションがあります。受信キュー（sqs）、運用担当のメールアドレス、ユーザー 3 人のメールアドレスです。ユーザーのサブスクリプションのフィルターポリシーの範囲は `MessageAttributes` です。
:::

::checks
