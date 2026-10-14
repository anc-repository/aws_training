---
step: tag-coverage
---

(Optional) Use Cost Explorer to see this month's costs broken down by the `Module` tag. This calls `ce:GetCostAndUsage` once — **billed per request** — so the command must say
`confirmCharges=yes` explicitly; the app caches the result for 12 hours, so running it again does not send another request.

```bash {runsOn=workstation}
npm run exp -- cost --label after --scenario tag-coverage --param confirmCharges=yes --upload
```

::experiment{module=cost id=tag-coverage label=after}

:::expected
`biz.untagged_share_pct` in the report is the share of this month's cost in the "untagged" group: costs without a `Module` tag (the workbench, hand-made resources, costs from before tag activation)
only ever land in the account budget; `biz.project_account_gap` is the difference between the two budgets' actual spend. This session's costs most likely have not appeared yet — exactly what "accurate but slow" means.
:::

:::warning
Do not turn Cost Explorer queries into polling: every call is billed. `/lab` also only calls it when you click "手动刷新" (refresh manually).
:::

::checks
