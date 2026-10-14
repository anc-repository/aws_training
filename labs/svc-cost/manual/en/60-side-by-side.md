---
step: side-by-side
---

Compare the two sides: on the `/lab` top bar, the local list (instant) is on the left and Budgets' "本月实际 / 预测 / 预算上限" (actual this month / forecast / budget limit; delayed) is on the right. You can also check from the workbench:

```bash {runsOn=workstation}
aws budgets describe-budgets --account-id {{ session.accountId }} --query "Budgets[].[BudgetName,CalculatedSpend.ActualSpend.Amount,CalculatedSpend.ForecastedSpend.Amount,BudgetLimit.Amount]" --output table
```

(Optional) Record both sides at the same moment as a snapshot:

```bash {runsOn=workstation}
npm run exp -- cost --label after --scenario visibility-lag --upload
```

::experiment{module=cost id=visibility-lag label=after}

:::expected
The local list contains this session's hourly resources; Budgets' actual spend most likely does not include them yet, and a new account usually has no forecast either (`ForecastedSpend` is empty).
Write down both values and why they differ (the manual confirmation below).
:::

:::saa{domain=cost confusable="Budgets vs 账单告警"}
CloudWatch `EstimatedCharges` billing alarms (the older approach) exist only in us-east-1, need billing alerts turned on, and only see the account total and per-service estimates — no tag filtering, no forecasts;
Budgets can filter by tag and supports forecast alerts and Budgets Actions.
:::

::checks
