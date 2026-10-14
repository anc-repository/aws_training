---
step: enable
---

AWS WAF を CloudFront に付けます。まず **Count** モードで観察します（マネージドルールグループはカウントするだけで、まだブロックしません）。

:::why
マネージドルールグループを新しく有効にするときは、まず Count にし、実際のトラフィックの COUNT の記録を数分間読み、誤検知がないことを確認してから Block に変えます。そうしないと、実際のユーザー（たとえば写真のアップロード）を誤ってブロックしやすくなります。
:::

:::method{kind=script default}
```bash {runsOn=workstation}
scripts/module enable waf --dry-run
```

内容を確認したら実行します（us-east-1 に Web ACL をデプロイしてから `WebAclArn` を cdn スタックに注入し、ディストリビューションが再デプロイされます。通常は数分です）。

```bash {runsOn=workstation}
scripts/module enable waf
```
:::

有効化のスクリプトは、インスタンス上の `denylist.conf` を IP セット `cloudalbum-blocklist`（us-east-1）に初回の全件インポートも行います。この時点ではオリジンはまだロックされていないので、`waf` は **DEP-018** により `degraded` と表示されます。これはこのカードでは想定内で、次のステップで直します。
