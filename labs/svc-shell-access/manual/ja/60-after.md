---
step: after
---

after を記録します。同じようにワークベンチからプライベートアドレスの 22 番と 443 番ポートを調べます。

```bash {runsOn=workstation}
npm run exp -- shell-access --label after --scenario probe-port --param target=private-ip --upload
```

::experiment{module=shell-access id=probe-port label=after}

:::expected
`port22.result` は `filtered`（すべてタイムアウト）になり、`sgRules22` は 0 です。443 は影響を受けません。`ssh lab` はタイムアウトするようになりますが、これこそ想定どおりです。
:::

:::tip
`npm run exp:report -- shell-access --experiment probe-port` で before と after を比較するレポートを生成できます。
:::

::checks
