---
step: sandbox
---

サンドボックスで**検証していない**アドレスに送るとどうなるでしょうか？自分で管理できるが SES で検証していないアドレスを 1 つ選んでください（example.com などの予約済みドメインは使わないでください。EmailPort はそれらには SES を呼び出しません）。
ランナーはそのアドレスでテストユーザーを登録し、確認メールを EmailPort に渡してから、サーバーの送信記録を読み取ります。

```bash {runsOn=workstation}
npm run exp -- email --label after --scenario sandbox --param to=<未検証のアドレス> --upload
```

::experiment{module=email id=sandbox label=after}

アプリのプレビューで管理者として `/admin/outbox` を開き、この確認メールを探します。

:::expected
状態は `failed`（赤）、エラーは `MessageRejected: Email address is not verified …`、経路セグメントは `email=ses:rejected` です。登録自体はいつもどおり完了します。
:::

:::why
SES アダプターは、失敗したメールをこっそり「送信済み」に書き換えたりしません。権威を持たないポートが失敗したときは `failed` と記録し、登録はいつもどおり完了します。`EMAIL_SANDBOX_POLICY=outbox`
（`scripts/module enable email --set EMAIL_SANDBOX_POLICY=outbox`）は明示的に選ぶデモ用のオプションで、このカードではデフォルトの `fail` のままにします。
:::

::checks
