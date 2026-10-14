---
step: side-by-side
---

両側を並べて比べます。`/lab` のトップバーの左側がローカルの一覧（即時）、右側が Budgets の「本月实际 / 预测 / 预算上限」（今月の実績 / 予測 / 予算の上限、遅れて反映）です。ワークベンチでも確認できます。

```bash {runsOn=workstation}
aws budgets describe-budgets --account-id {{ session.accountId }} --query "Budgets[].[BudgetName,CalculatedSpend.ActualSpend.Amount,CalculatedSpend.ForecastedSpend.Amount,BudgetLimit.Amount]" --output table
```

（任意）同じ時点の両側の値を 1 回のスナップショットとして記録します。

```bash {runsOn=workstation}
npm run exp -- cost --label after --scenario visibility-lag --upload
```

::experiment{module=cost id=visibility-lag label=after}

:::expected
ローカルの一覧にはこのセッションの時間課金リソースがありますが、Budgets の実際の支出にはまだ含まれていないことがほとんどです。新しいアカウントには通常予測もありません（`ForecastedSpend` が空）。
両側の値と差の理由を記録してください（下の手動確認）。
:::

:::saa{domain=cost confusable="Budgets vs 账单告警"}
CloudWatch の `EstimatedCharges` 請求アラーム（以前の方法）は us-east-1 にしかなく、請求アラームの有効化が必要で、アカウントの合計額とサービス別の見積もりしか見られず、タグでの絞り込みも予測もできません。
Budgets はタグで絞り込め、予測アラートと Budgets Actions に対応します。
:::

::checks
