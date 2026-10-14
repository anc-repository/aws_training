---
step: after-payloads
---

**after** の 2 つ目を記録します。同じペイロード一式を直接アクセスとエッジに同時に送り、ステップ 2 の before と組にします。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario payloads --param target=both --upload
npm run exp:report -- waf --experiment payloads
```

::experiment{module=waf id=payloads label=after}

:::expected
エッジ側でブロックしたペイロードは直接アクセス側より少なくなく、特にエンコードや大文字小文字のバリエーションで差が出ます。`caughtOnlyByWaf` に、Nginx が見逃してマネージドルールグループがブロックしたバリエーションが並びます。
マネージドルールグループにブロックされたリクエストは CloudFront の 403 を返し、同じくオリジンのログには入りません。
:::

:::tip
マネージドルールグループは AWS が継続的に更新するため、同じペイロード一式でも時期によって結果が少し変わることがあります。これこそが手書きの正規表現との違いです。
:::

::checks
