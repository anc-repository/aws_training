---
step: side-by-side
---

并排对照两侧：`/lab` 顶栏左边是本地清单（立即），右边是 Budgets 的“本月实际 / 预测 / 预算上限”（滞后）。在工作台上也可以看：

```bash {runsOn=workstation}
aws budgets describe-budgets --account-id {{ session.accountId }} --query "Budgets[].[BudgetName,CalculatedSpend.ActualSpend.Amount,CalculatedSpend.ForecastedSpend.Amount,BudgetLimit.Amount]" --output table
```

（选做）把同一时刻的两侧读数记成一次快照：

```bash {runsOn=workstation}
npm run exp -- cost --label after --scenario visibility-lag --upload
```

::experiment{module=cost id=visibility-lag label=after}

:::expected
本地清单里有本会话的按小时资源；Budgets 的实际花费多半还没有包含它们，新账号通常也没有预测（`ForecastedSpend` 为空）。
记下两侧的数值与差异原因（下方的手动确认）。
:::

:::saa{domain=cost confusable="Budgets vs 账单告警"}
CloudWatch 的 `EstimatedCharges` 账单告警（旧做法）只在 us-east-1、需要开启账单告警，只看账号总额与按服务的估算值，不能按标签、不做预测；
Budgets 可以按标签筛选、支持预测告警与 Budgets Actions。
:::

::checks
