---
step: force-https
---

（任意、ACME の分岐）直接アクセスの `http://` を `https://` にリダイレクトし、HSTS を付けます。`max-age` はまず小さな値（300 秒）にし、終了前に必ず無効にしてください。

:::method{kind=script default}
まずプレビューを確認してから実行します。

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }} --set TLS_FORCE_HTTPS=true --set TLS_HSTS_MAX_AGE=300 --dry-run
scripts/module enable tls --domain {{ learner.inputs.domain }} --set TLS_FORCE_HTTPS=true --set TLS_HSTS_MAX_AGE=300
```
:::

```bash {runsOn=workstation}
curl -sI http://{{ target.publicIp }}/ | grep -iE '^(HTTP|location)'
curl -sI https://{{ learner.inputs.domain }}/api/health/live | grep -i strict-transport
```

:::expected
1 つ目は `301` と `Location: https://…` を返します。2 つ目は `Strict-Transport-Security: max-age=300` を返します。ループバックアドレス（プラットフォームのローカルチェック）と
`/.well-known/acme-challenge/` はリダイレクトされません。
:::

:::danger
HSTS はブラウザーに `max-age` 秒間記憶されます。その間、ブラウザーは HTTP や自己署名証明書に戻ることを拒否します。tls を無効にする前に、先に HSTS を無効にしてください。

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }} --set TLS_FORCE_HTTPS=false
```
:::

::checks
