---
step: domain-identity
---

自分のドメインがある場合は、**ドメイン ID** に切り替えます。Easy DKIM を有効にすると、SES が CNAME を 3 件生成します。ドメインは `{{ learner.inputs.domain }}` です（サブドメインがおすすめです。例：`mail.<あなたのドメイン>`）。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable email --param Domain={{ learner.inputs.domain }} --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable email --param Domain={{ learner.inputs.domain }}
```
:::

スクリプトは `InfoDkimRecords` として 3 件の `<token>._domainkey.<ドメイン> CNAME <token>.dkim.amazonses.com` を表示します。DNS プロバイダーでそのまま追加してください
（dns モジュールが有効なら、スタックが Route 53 に書き込みます）。

:::wait{typical=10 max=20}
DNS が反映されて初めて SES がドメインを検証でき、DKIM の状態が「成功」になります。スクリプトは「検証済み」になるまでポーリングしてから env を書き込みます。
:::

:::expected
`aws sesv2 get-email-identity --email-identity {{ learner.inputs.domain }}` の `DkimAttributes.Status` が `SUCCESS` です。
これ以降に送信したメールでは、`DKIM-Signature` の `d=` があなたのドメインになり、送信元ドメインとそろいます。
:::

:::tip
終わったら、外部の DNS プロバイダーに手動で追加した DKIM レコードを忘れずに削除してください。
:::

::checks
