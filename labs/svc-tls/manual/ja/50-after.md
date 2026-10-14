---
step: after
---

before と同じ方法でもう一度測定します。

```bash {runsOn=workstation}
npm run exp -- tls --label after --scenario inspect --upload
```

::experiment{module=tls id=inspect label=after}

:::expected
信頼された入口の数（`trustedEntries`）が増えます。ACME の分岐では直接アクセスの入口が Amazon の発行になり、フォールバックの分岐では CloudFront の代替ドメイン名が us-east-1 の統合証明書を使います。
レポートでは before と after が比較できる組として示されます。
:::

**ACME の分岐：更新の演習。** 5 秒目にラボ用インスタンスで `certbot renew --dry-run` を実行し、続けて `--force-renewal` を実行します（もう 1 回発行し、ドメインごとに課金されます）。

```bash {runsOn=workstation}
npm run exp -- tls --label after --scenario renew-drill --fault-via ssm --upload
```

::experiment{module=tls id=renew-drill label=after}

:::expected
`renewed` は true、`secondsToNewCert` は 2 分前後です。新しい証明書（シリアル番号が変わる）が実際に Nginx に導入されました。ACM コンソールで ACME のフィルター条件を使って確認すると、
証明書の ARN は変わっていません（同じ ACME アカウント、同じドメインと鍵アルゴリズム）。
:::

:::tip
任意：4 つのリージョンの CloudShell で `--scenario handshake` を実行し、CloudFront 経由と直接アクセスの TLS ハンドシェイクの所要時間を比べます。`--scenario cipher-scan` には nmap が必要です。
:::

::checks
