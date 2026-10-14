---
step: seed
---

まずテストユーザーを 2 人用意します。スクリプトはアプリの公開 API を通じて `+u1`、`+u2` の 2 つのサブアドレスを登録し、`/api/admin/outbox` の確認コードでメールアドレスの確認を済ませ
（出発点の email は outbox なので、確認メールは実際には送信されません）、それぞれ公開の小さな写真を 1 枚アップロードし、「メール通知」を有効にします。`--no-admins` で一般ユーザーのままにし、
サブスクリプションフィルターポリシーは `userId` だけで照合します。

```bash {runsOn=workstation}
npm run exp:login -w @cloudalbum/experiments
npx tsx experiments/notification/seed-users.ts --count 2 --email {{ learner.inputs.notify-email }} --no-admins
```

一覧はワークベンチの `.cloudalbum/experiments/notification-users.json` に書き込まれます（0600。この 2 つのテストアカウントのパスワードを含み、この実験専用です）。

次に、出発点の機能の状態を確認します。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules | {notification: .notification.driver, email: .email.driver}'
```

:::why
**なぜ最初のステップでユーザーを作っておくのでしょうか？** シードスクリプトは outbox の確認コードでメールアドレスの確認を済ませます。SES に切り替えると確認メールが実際に送信されますが、サンドボックス期間中の SES は検証済みのアドレスにしか送れません。
outbox の階層のうちにユーザーを準備しておけば、後の比較実験で前後とも同じユーザーを使えます。
:::

:::expected
スクリプトはユーザーごとに `u1  you+u1@…  member  photo=…  邮件通知=on（db）` のような行を 1 行出力します。notification のドライバーは `db`、email のドライバーは `outbox` です。
:::

::checks
