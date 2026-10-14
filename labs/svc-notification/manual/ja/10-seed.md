---
step: seed
---

まずテストユーザーを 3 人用意します。スクリプトはアプリの公開 API を通じて `+u1`～`+u3` の 3 つのサブアドレスを登録し、`/admin/outbox` の確認コードでメールアドレスの確認を済ませ、
それぞれ公開の小さな写真を 1 枚アップロードし（後でこれらにコメントします）、「メール通知」を有効にしてから、管理者に設定します（「管理者向けブロードキャスト」のテスト用）。

```bash {runsOn=workstation}
npm run exp:login -w @cloudalbum/experiments
npx tsx experiments/notification/seed-users.ts --count 3 --email {{ learner.inputs.notify-email }}
```

一覧はワークベンチの `.cloudalbum/experiments/notification-users.json` に書き込まれます（0600。この 3 つのテストアカウントのパスワードを含み、この実験専用です）。

:::why
**なぜ全員を管理者にするのでしょうか？** db ドライバーは「管理者向けブロードキャスト」（たとえば日次レポートの完了）をすべての管理者に 1 通ずつ送ります。SNS 側では 1 つのフィルターポリシー
`{"$or":[{"userId":[…]},{"audience":["admin"]}]}` で各管理者にもブロードキャストを届けます。両者を比較するとき、受信者は同じ顔ぶれになります。
:::

アプリのプレビューで「设置」（設定）を開きます。メール通知は有効になっていて、しかもすぐに反映されています。db ドライバーはブール値を 1 つ変えるだけなので、確認は一切不要です。

:::expected
スクリプトはユーザーごとに `u1  you+u1@…  admin  photo=…  邮件通知=on（db）` のような行を 1 行出力します。capabilities の notification のドライバーは `db` です。
:::

::checks
