---
step: baseline
---

before を記録します。アプリに「自分は誰で、どの認証情報を使っているか」を報告させます。

```bash {runsOn=workstation}
npm run exp -- iam --label before --scenario whoami --upload
```

::experiment{module=iam id=whoami label=before}

:::expected
レポートには呼び出し元の ARN がありません。アプリは AWS SDK を読み込んでおらず、認証情報も一切持っていないからです。
:::

::checks
