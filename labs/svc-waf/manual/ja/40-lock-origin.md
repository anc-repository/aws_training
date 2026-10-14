---
step: lock-origin
---

オリジンをロックします。CloudFront からのオリジンリクエストだけを許可し、直接アクセスの入口はあなたのワークベンチにだけ開きます。これで WAF は迂回できなくなります。

:::tip
`--param` ではなく `--set`（cdn の `ownsEnv` キーに書き込む）を使います。ロック後はプラットフォームの Lambda からラボ用インスタンスのパブリックな入口にアクセスできなくなるため、以降の直接アクセス系のチェックはラボ用インスタンス / ワークベンチから行います。
:::

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR={{ workstation.publicIp }}/32 --dry-run
```

内容を確認したら実行します（cdn スタックがセキュリティグループと直接アクセスのポリシーを更新し、ディストリビューションが再デプロイされます。通常は数分です）。

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR={{ workstation.publicIp }}/32
```
:::

:::expected
`waf` が `ok` になります（DEP-018 が消えます）。次のステップの `bypass` の after では、直接アクセスで到達できないことが示されます。
:::
