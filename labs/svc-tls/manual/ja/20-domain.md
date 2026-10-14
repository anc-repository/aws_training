---
step: domain
---

あなたの DNS で `{{ learner.inputs.domain }}` に、ラボ用インスタンス `{{ target.publicIp }}` を指す A レコードを追加し（ブラウザーはこれを頼りにラボ用インスタンスを見つけます）、確認します。

```bash {runsOn=workstation}
dig +short {{ learner.inputs.domain }} @8.8.8.8
```

:::expected
`{{ target.publicIp }}` が出力されます。DNS の変更が反映されるまでの時間は、DNS プロバイダーとレコードの元の TTL によります。
:::

**フォールバックの分岐（バリアント `acme-off`）では、もう 1 つ作業があります**。DEP-005 ③ は「dns または外部 DNS」を求めるので、外部 DNS のローカル階層でアプリの有効な入口をあなたのドメインに変えます
（AWS のリソースは何もデプロイせず、`MODULE_DNS=on` も書き込みません）。

```bash {runsOn=workstation}
scripts/module enable dns --driver external --domain {{ learner.inputs.domain }}
```

:::warning
フォールバックの分岐では、ステップ 4 でこの名前を CloudFront ディストリビューションへの CNAME に変えます。同じ名前に A と CNAME を同時には持てず、外部 DNS のゾーンの頂点には CNAME を作れないため、
フォールバックの分岐ではサブドメイン（たとえば `lab.example.com`）を使う必要があります。
:::

::checks
