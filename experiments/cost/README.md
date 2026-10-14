# cost 实验（本地估算 vs AWS Budgets / Cost Explorer）

设计：[docs/modules/06-governance-cost.md#cost](../../docs/modules/06-governance-cost.md) 第 5 节。核心对照：本地清单“快而粗”
（registry 计费维度 × 模块启用时长，启用即出现，不知道钱），Budgets / Cost Explorer“准而慢”（实际账单数据，滞后数小时到一天，
预测需要约 5 周的历史）。**本项目不写任何价格**：金额只来自 AWS 的账单数据，或学员在 `cost-rates.yaml` 中注明出处与日期抄录的单价。

| 标签 | 前置条件（capabilities） |
|---|---|
| `before` | `cost.driver=local` |
| `after` | `cost.driver=budgets`、`cost.status=ok/degraded`（标签尚未生效时为 degraded，属正常） |

服务端接口（`backend/src/adapters/cost/lab-routes.ts`，仅管理员）：`GET /api/lab/cost`（本地清单、两个预算、提醒、Cost Explorer 缓存）、
`POST /api/lab/cost/refresh`（请求体 `{"confirm":"ce-charges"}`；调用一次 `ce:GetCostAndUsage`，**按请求计费**，12 小时内复用缓存）。

## visibility-lag（同一时刻的快照）

```bash
npm run exp -- cost --label before --scenario visibility-lag
scripts/module enable cost --param ProjectBudgetLimit=<金额> --param AccountBudgetLimit=<金额> --param AlertEmail=you@example.com
npm run exp -- cost --label after --scenario visibility-lag --upload
npm run exp -- cost --label after --scenario visibility-lag --param refreshCe=true --param confirmCharges=yes   # 可选，按请求计费
```

会话内通常只能看到“还没有”：本地清单里刚启用的模块，在 Budgets 与 Cost Explorer 中要过数小时到一天才出现。
`biz.modules_not_yet_in_ce` 就是“清单里有、账单里还没有”的模块数。完整做法是在启用一个按小时计费的模块后每隔数小时
（不要高频，每次都计费）重复最后一条命令，记下费用首次出现的时间。

## tag-coverage

```bash
npm run exp -- cost --label after --scenario tag-coverage --param confirmCharges=yes --upload
```

按 `Module` 标签分组看本月费用，“无标签”一组（`biz.untagged_share_pct`）只会进入账号预算；`biz.project_account_gap` 是两个预算的实际差额。

## threshold-alert（手工）

1. `scripts/module enable cost --param ProjectBudgetLimit=<一个很小的金额> --param AccountBudgetLimit=<金额> --param AlertEmail=you@example.com`
2. 等待“实际花费超过 80%”的邮件与 SNS 消息（账单数据至少每天更新一次，以官方文档为准，可能要到第二天）。
3. 实验后把金额改回（再执行一次 enable）。不以“预测超支”作为必做步骤：没有足够的用量历史时 Budgets 不生成预测。

## idle-reminder（手工）

1. 在实验机的 `/etc/cloudalbum/local.override.env` 中临时写 `COST_LOCAL_IDLE_HOURS=1`（会出现 CFG-005 横幅），重启 api 与 worker。
2. 启用一个按小时计费的模块后不做任何实验；约 1 小时后（worker 每 10 分钟检查一次）管理员收到站内信与邮件，`GET /api/lab/cost` 的 `reminders` 非空。
3. 实验后删除覆盖文件并重启。实例停机时提醒也随之停止——这是本地实现的局限。

## budget-action-canary（手工，只看配置）

```bash
scripts/module enable cost --param ProjectBudgetLimit=<金额> --param AccountBudgetLimit=<金额> --param EnableBudgetAction=true
aws budgets describe-budget-actions-for-budget --account-id <账号> --budget-name cloudalbum-lab-project-monthly
aws iam list-attached-role-policies --role-name cloudalbum-lab-cost-canary     # 触发后才会出现 AWSDenyAll
```

动作只把 AWS 托管策略 `AWSDenyAll` 附加到金丝雀角色 `cloudalbum-<env>-cost-canary`（没有任何组件使用它），绝不指向应用角色或实验机。
实验后在 Budgets 控制台撤销已执行的动作，并以 `EnableBudgetAction=false` 重新 enable。
