---
step: tag-coverage
---

（选做）用 Cost Explorer 按 `Module` 标签看本月费用的分布。这会调用一次 `ce:GetCostAndUsage`——**按请求计费**，所以命令里必须
显式写 `confirmCharges=yes`；应用会把结果缓存 12 小时，重复执行不会再发请求。

```bash {runsOn=workstation}
npm run exp -- cost --label after --scenario tag-coverage --param confirmCharges=yes --upload
```

::experiment{module=cost id=tag-coverage label=after}

:::expected
报告的 `biz.untagged_share_pct` 是“无标签”一组占本月费用的比例：不带 `Module` 标签的费用（工作台、手工资源、标签激活之前的费用）
只会进入账号预算；`biz.project_account_gap` 是两个预算实际花费的差额。会话内的费用多半还没出现——这正是“准而慢”。
:::

:::warning
不要把 Cost Explorer 的查询做成轮询：每次调用都计费。`/lab` 也只在你点“手动刷新”时调用。
:::

::checks
