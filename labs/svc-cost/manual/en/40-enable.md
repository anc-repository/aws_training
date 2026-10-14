---
step: enable
---

Wire in AWS Budgets. The module creates the project budget `cloudalbum-{{ session.env }}-project-monthly` (filtered on `Project=CloudAlbum`) and the account budget
`cloudalbum-{{ session.env }}-account-monthly` (no filter). Both have two notification levels, "actual spend > 80%" and "forecasted spend > 100%", sent to your email address and to the
SNS topic `cloudalbum-{{ session.env }}-cost`. The two amounts **have no defaults**; decide them based on what you can afford.

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable cost --param ProjectBudgetLimit={{ var.projectBudgetLimit }} --param AccountBudgetLimit={{ var.accountBudgetLimit }} --param AlertEmail={{ learner.inputs.notify-email }} --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable cost --param ProjectBudgetLimit={{ var.projectBudgetLimit }} --param AccountBudgetLimit={{ var.accountBudgetLimit }} --param AlertEmail={{ learner.inputs.notify-email }}
```
:::

In platform mode, the out-of-band step "activate cost allocation tags" in the command is skipped and points you to the matching platform action `cost-activate-tags` — the learner identity does not have that permission, so this is expected.

:::wait{typical=3 max=15}
Deploying the budgets and the topic usually takes a minute or two. Right after that, cost is yellow with "订阅未确认" (subscription not confirmed), and turns healthy once you confirm the email; if the cost allocation tag has not taken effect yet, it stays yellow with
"成本分配标签 Project 尚未生效" (cost allocation tag Project not in effect yet) — that usually will not resolve within a session, so this one kind of yellow is allowed.
:::

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.cost | {driver, status, detail}'
```

:::expected
`driver` is `budgets`; detail reads "AWS Budgets 预算 2 个（项目：本月实际 … · 预测 暂无 · 上限 …；账号：…）· 本地：当前按小时计费的资源 …" (2 AWS Budgets budgets (project: actual this month … · forecast none · limit …; account: …) · local: hourly-billed resources now …).
The local list never stopped; the Budgets readings simply appear next to it.
:::

:::why
**Why do the budgets exclude credits?** New accounts run on credits, which offset the bill: if a budget included credits, net spend could stay near 0 and the alert would never fire,
while the credits were being used up. The template sets `CostTypes.IncludeCredit` to false.
:::

::checks
