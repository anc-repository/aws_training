---
step: tag-coverage
---

（任意）Cost Explorer で `Module` タグごとに今月の費用の内訳を見ます。これは `ce:GetCostAndUsage` を 1 回呼び出します。**リクエストごとに課金される**ため、コマンドには
`confirmCharges=yes` を明示的に書く必要があります。アプリは結果を 12 時間キャッシュするので、繰り返し実行してもリクエストは再送されません。

```bash {runsOn=workstation}
npm run exp -- cost --label after --scenario tag-coverage --param confirmCharges=yes --upload
```

::experiment{module=cost id=tag-coverage label=after}

:::expected
レポートの `biz.untagged_share_pct` は、今月の費用に占める「タグなし」グループの割合です。`Module` タグのない費用（ワークベンチ、手動で作ったリソース、タグ有効化前の費用）は
アカウント予算にしか入りません。`biz.project_account_gap` は 2 つの予算の実際の支出の差です。セッション中の費用はたいていまだ現れません。これがまさに「正確だが遅い」ということです。
:::

:::warning
Cost Explorer のクエリをポーリングにしないでください。呼び出すたびに課金されます。`/lab` でも「手动刷新」（手動で更新）を押したときにしか呼び出しません。
:::

::checks
