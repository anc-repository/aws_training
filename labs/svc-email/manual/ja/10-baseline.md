---
step: baseline
---

まずローカルの outbox を見ます。右側の「アプリのプレビュー」でサインアウトし、任意のアドレスで新しいユーザーを登録します。登録完了ページには「本站未启用真实邮件，验证邮件已写入 outbox」（このサイトでは実際のメールは無効で、確認メールは outbox に書き込まれました）と表示されます。
`/me/outbox` を開き、確認メールのリンクをクリックして確認を完了します。この間、1 通のメールも EC2 の外に出ていません。

次に before を記録します。ランナーは SES メールボックスシミュレーターの 3 つのアドレス（success、bounce、complaint）とあなたのメールアドレスでテストユーザーを 1 人ずつ登録し、「パスワードの再設定」を送らせます。
そしてサーバー側（`/api/admin/outbox`）から各メールの記録を読み取ります。

```bash {runsOn=workstation}
npm run exp:login -w @cloudalbum/experiments
npm run exp -- email --label before --scenario send-matrix --param to={{ learner.inputs.ses-identity }} --upload
```

::experiment{module=email id=send-matrix label=before}

:::expected
レポートでは 4 つのアドレスの `transport` はすべて `outbox`、`deliveryStatus` はすべて `none` です。`/admin/outbox` の上部には「邮件未真正发出（本地 outbox）」（メールは実際には送信されていません（ローカルの outbox））と書かれています。
:::

:::tip
任意の register-latency をこの outbox 階層と比べたい場合は、今のうちに 1 回実行しておきます：
`npm run exp -- email --label before --scenario register-latency`（登録 API は IP ごとに 10 分あたり 20 回まで）。
:::

::checks
