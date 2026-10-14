---
step: sandbox
---

サンドボックスで**検証していない**アドレスに送るとどうなるでしょうか？ 自分で管理できるけれど SES で検証していないアドレスを 1 つ選んでください（example.com などの予約済みドメインは使わないこと。
EmailPort はそれらに対して SES を呼び出しません）。ランナーはそのアドレスでテストユーザーを登録し、確認メールを EmailPort に渡してから、サーバー側の送信記録を読み取ります。

```bash {runsOn=workstation}
npm run exp -- email --label after --scenario sandbox --param to=<未検証のアドレス>
aws sesv2 get-account --query "{production:ProductionAccessEnabled,quota:SendQuota}"
```

::experiment{module=email id=sandbox label=after}

`/admin/outbox` でこの確認メールを探します。

:::expected
状態は `failed`（赤く表示）、エラーは `MessageRejected: Email address is not verified …`、経路セグメントは `email=ses:rejected` です。
`get-account` は `production: false` を表示します。`EMAIL_SANDBOX_POLICY=outbox` を設定している場合、拒否されたメールはローカルの outbox に書き換えられ、同じく「未真正发出」（実際には未送信）と表示されます。
:::

:::why
SES アダプターが、失敗したメールをこっそり「送信済み」に書き換えることはありません。権威を持たないポートが失敗したときは `failed` と記録し、モジュールの状態は degraded になり、登録自体は影響を受けません。
`EMAIL_SANDBOX_POLICY=outbox`（`scripts/module enable email --set EMAIL_SANDBOX_POLICY=outbox`）は明示的に選ぶデモ用のオプションで、サンドボックス中に登録した新しいユーザーが
`/me/outbox` で確認を完了できるようにするためのものです。
:::

::checks
