---
section: wrap-up
---

## 你做到了什么

- 搭好了费用护栏：项目预算（按标签）+ 账号预算（兜底），实际与预测两档通知，送到邮箱与 SNS。
- 把“快而粗”的本地清单与“准而慢”的 Budgets 并排看，知道两侧为什么不一致。
- 知道单价只能来自你注明出处的抄录，本项目不内置任何价格。

## 考点回顾

- AWS Budgets（成本、用量、RI / Savings Plans 预算；实际与预测告警；Budgets Actions）与 Cost Explorer、成本与使用情况报告、
  Cost Anomaly Detection、Pricing Calculator 的区分。
- 成本分配标签：用户定义与 AWS 生成；必须激活；有延迟；不追溯；组织中由管理账号激活。
- CloudWatch 账单告警（`EstimatedCharges`，us-east-1）与 Budgets 的对比。
- 降本手段：按需 / Savings Plans / 预留实例 / Spot；Compute Optimizer；Trusted Advisor；关闭空闲资源。
- 识别按小时计费的资源：公网 IPv4、NAT Gateway、Interface Endpoint、RDS、ElastiCache。
