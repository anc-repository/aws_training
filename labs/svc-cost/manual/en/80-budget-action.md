---
step: budget-action
---

(Optional) Budgets Actions can act automatically when a threshold is crossed: attach an IAM policy or SCP, or stop EC2 / RDS instances. This card only demonstrates the safest kind:
attaching the AWS managed policy `AWSDenyAll` to a **canary role that no component uses** — never the app role or the lab instance.

:::method{kind=script default}
Preview the changes first (only the budget action, the canary role and the action's execution role are added):

```bash {runsOn=workstation}
scripts/module enable cost --param ProjectBudgetLimit={{ var.projectBudgetLimit }} --param AccountBudgetLimit={{ var.accountBudgetLimit }} --param AlertEmail={{ learner.inputs.notify-email }} --param EnableBudgetAction=true --dry-run
```

When you are happy with them, run it and look at the action's configuration:

```bash {runsOn=workstation}
scripts/module enable cost --param ProjectBudgetLimit={{ var.projectBudgetLimit }} --param AccountBudgetLimit={{ var.accountBudgetLimit }} --param AlertEmail={{ learner.inputs.notify-email }} --param EnableBudgetAction=true
aws budgets describe-budget-actions-for-budget --account-id {{ session.accountId }} --budget-name cloudalbum-{{ session.env }}-project-monthly
aws iam list-attached-role-policies --role-name cloudalbum-{{ session.env }}-cost-canary
```
:::

::console-link[Open the Budgets console]{link=budgets.home}

:::expected
The action type is `APPLY_IAM_POLICY` and the target role is `cloudalbum-{{ session.env }}-cost-canary`; until the billing data actually crosses the threshold, the canary role has
no policy attached yet — there is no need to wait for it to fire.
:::

:::warning
When Budgets Actions stops instances in an Auto Scaling group, Auto Scaling immediately launches replacements; pointing an action at the app role could make the guardrail shut down the app itself.
That is why this project only uses actions on a canary role.
:::

::checks
