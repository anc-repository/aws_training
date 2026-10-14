---
step: before
---

まず出発点を記録します。ラボ用インスタンスの 443 の自己署名証明書です。

```bash {runsOn=workstation}
npm run exp -- tls --label before --scenario inspect --upload
```

::experiment{module=tls id=inspect label=before}

:::expected
`entries` の直接アクセスの入口の `issuer` と `subject` はどちらも `cloudalbum-l0`、`trusted` は false、`kind` は `selfsigned` です。
経路ヘッダーの `tls` 区間は `selfsigned@nginx` です。
:::

次にブラウザーの新しいタブで `https://{{ target.publicIp }}/` を開きます。ブラウザーは警告ページ（証明書が無効）を表示します。これが「暗号化されているが信頼されていない」状態です。

:::why
自己署名証明書の発行者は自分自身で、信頼されたルート証明書は何も保証していません。ブラウザーは接続先が本物のアルバムかどうか確認できないため、ブロックします。
他のオリジンからの fetch も失敗し、実際のユーザーは HTTPS に依存する Cognito のコールバックを使えません。
:::

::checks
