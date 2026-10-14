---
step: budget-action
---

（选做）Budgets Actions 能在超过阈值时自动执行动作：附加 IAM 策略或 SCP、停止 EC2 / RDS 实例。本卡只演示最安全的一种——
把 AWS 托管策略 `AWSDenyAll` 附加到一个**没有任何组件使用的金丝雀角色**，绝不指向应用角色或实验机。

:::method{kind=script default}
先看变更预览（只多出预算动作、金丝雀角色与动作的执行角色）：

```bash {runsOn=workstation}
scripts/module enable cost --param ProjectBudgetLimit={{ var.projectBudgetLimit }} --param AccountBudgetLimit={{ var.accountBudgetLimit }} --param AlertEmail={{ learner.inputs.notify-email }} --param EnableBudgetAction=true --dry-run
```

确认后执行，再查看动作的配置：

```bash {runsOn=workstation}
scripts/module enable cost --param ProjectBudgetLimit={{ var.projectBudgetLimit }} --param AccountBudgetLimit={{ var.accountBudgetLimit }} --param AlertEmail={{ learner.inputs.notify-email }} --param EnableBudgetAction=true
aws budgets describe-budget-actions-for-budget --account-id {{ session.accountId }} --budget-name cloudalbum-{{ session.env }}-project-monthly
aws iam list-attached-role-policies --role-name cloudalbum-{{ session.env }}-cost-canary
```
:::

::console-link[打开 Budgets 控制台]{link=budgets.home}

:::expected
动作类型为 `APPLY_IAM_POLICY`，目标角色是 `cloudalbum-{{ session.env }}-cost-canary`；在账单数据真正超过阈值之前，金丝雀角色上
还没有附加任何策略——不必等待触发。
:::

:::warning
Budgets Actions 停止 Auto Scaling 组中的实例时，Auto Scaling 会立刻补一台新的；把动作指向应用角色则可能让护栏把应用自己关掉。
这也是本项目只把动作用在金丝雀角色上的原因。
:::

::checks
