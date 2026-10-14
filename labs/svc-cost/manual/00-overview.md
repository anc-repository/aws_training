---
section: overview
---

## 背景

没有 Budgets 时，应用根据 registry 里每个模块声明的计费维度（`billing`）和模块启停记录，列出“现在有哪些按小时计费的资源、
各开了多久”——这就是 `/lab` 顶栏左侧的本地清单。它能**立即**看到“RDS 刚被打开”，但看不到真实账单：数据传输与请求类费用、
手工创建的资源、税费、抵扣额度都不在其中；而且**本项目不内置任何价格**，只有你自己从官方定价页抄录单价（注明出处与日期）时才显示估算金额。

这张卡片用 AWS Budgets 建两个月度预算：项目预算按成本分配标签 `Project=CloudAlbum` 筛选，账号预算不筛选；实际花费超过 80% 或
预测会超支时发邮件与 SNS 通知。Cost Explorer 按 `Module` 标签给出真实的费用分布。

:::why
Budgets 依据的账单数据至少每天更新一次（以官方文档为准），所以它适合做“月度护栏”，不适合发现“开了一小时忘关”——后者靠本地清单与空开提醒。
两侧并排看，才能同时得到“快”和“准”。
:::

## 你在一个会话里能看到什么

- **能看到**：护栏怎么搭（两个预算、通知、主题、可选的预算动作），以及两侧为什么不一致。
- **通常看不到**：本次会话产生的费用出现在 Budgets 与 Cost Explorer 里（滞后数小时到一天），预测告警（需要约 5 周的用量历史）。
  “告警真正响起”通常发生在会话结束之后。

## 对比实验预告

本卡没有必需的对比实验：模块文档的五个场景要么依赖账单数据的天级延迟，要么需要按小时计费的模块空开数小时。下面两个都是选做。

### 同一时刻两侧快照（cost/visibility-lag，选做）

- **没有 Budgets（本地清单）**：资源启用即出现在清单中，但不知道钱。
- **有了 Budgets**：费用要滞后数小时到一天才出现在 Budgets 与 Cost Explorer 中；会话内多半还是“还没有”。
- **你会在哪里看到**：报告中的 `biz.local_module_items` 与 `biz.budgets_project_actual`。

### 标签覆盖（cost/tag-coverage，选做）

- Cost Explorer 按 `Module` 分组，“无标签”一组只会进入账号预算（`biz.untagged_share_pct`）。
- 它调用一次按请求计费的 `ce:GetCostAndUsage`，必须显式确认（`--param confirmCharges=yes`）。

## 平台模式说明

成本分配标签的激活需要 `ce:UpdateCostAllocationTagsStatus`，学员身份没有这个权限：请用卡片里的平台动作“激活成本分配标签”，
最好在开始实验前一天完成。平台安装时可能创建的 `atl-platform-guard` 预算属于平台，与本卡的两个预算是两回事，不要修改它。

::platform-action{id=cost-activate-tags}
