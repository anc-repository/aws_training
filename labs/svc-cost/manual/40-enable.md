---
step: enable
---

接入 AWS Budgets。模块会创建：项目预算 `cloudalbum-{{ session.env }}-project-monthly`（按 `Project=CloudAlbum` 筛选）、账号预算
`cloudalbum-{{ session.env }}-account-monthly`（不筛选），两者都有“实际花费 > 80%”与“预测花费 > 100%”两档通知，通知同时发给你的邮箱与
SNS 主题 `cloudalbum-{{ session.env }}-cost`。两个金额**没有默认值**，由你根据自己的承受能力决定。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable cost --param ProjectBudgetLimit={{ var.projectBudgetLimit }} --param AccountBudgetLimit={{ var.accountBudgetLimit }} --param AlertEmail={{ learner.inputs.notify-email }} --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable cost --param ProjectBudgetLimit={{ var.projectBudgetLimit }} --param AccountBudgetLimit={{ var.accountBudgetLimit }} --param AlertEmail={{ learner.inputs.notify-email }}
```
:::

平台模式下，命令里“激活成本分配标签”这一带外步骤会被跳过，并提示对应的平台动作 `cost-activate-tags`——学员身份没有这个权限，这是预期的。

:::wait{typical=3 max=15}
部署预算与主题通常一两分钟。完成后 cost 先是黄色“订阅未确认”，确认邮件后变为正常；如果成本分配标签还没生效，会一直是黄色
“成本分配标签 Project 尚未生效”——会话内通常等不到，这一种黄色是允许的。
:::

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.cost | {driver, status, detail}'
```

:::expected
`driver` 为 `budgets`；detail 写着“AWS Budgets 预算 2 个（项目：本月实际 … · 预测 暂无 · 上限 …；账号：…）· 本地：当前按小时计费的资源 …”。
本地清单从未停止，只是旁边多了 Budgets 的读数。
:::

:::why
**为什么预算不计入抵扣额度？** 新账号使用抵扣额度制，额度会抵掉账单：预算若计入抵扣额度，净花费可能一直接近 0、告警永远不响，
而额度正在被消耗。模板把 `CostTypes.IncludeCredit` 设为 false。
:::

::checks
