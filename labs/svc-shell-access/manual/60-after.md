---
step: after
---

记录 after：同样从工作台探测私网地址的 22 与 443 端口。

```bash {runsOn=workstation}
npm run exp -- shell-access --label after --scenario probe-port --param target=private-ip --upload
```

::experiment{module=shell-access id=probe-port label=after}

:::expected
`port22.result` 变成 `filtered`（全部超时），`sgRules22` 为 0；443 不受影响。`ssh lab` 现在会超时——这正是预期。
:::

:::tip
`npm run exp:report -- shell-access --experiment probe-port` 生成 before 对 after 的报告。
:::

::checks
