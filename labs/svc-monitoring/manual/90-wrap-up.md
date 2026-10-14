---
section: wrap-up
---

## 你做到了什么

- 把告警从“实例里的评估器”搬到 AWS 侧：停服务、停实例时，心跳告警照样响，并经 SNS 送达。
- 看到了 CloudWatch 的代价：告警是分钟级，自定义指标、告警按量计费。
- 用 Agent 补上了 EC2 默认没有的内存与磁盘指标。

## 考点回顾

- 基础监控与详细监控；EC2 没有内存和磁盘使用率，需要 CloudWatch Agent；系统与实例状态检查。
- 告警三种状态、周期与 M of N、`TreatMissingData`、指标数学、复合告警（只能通知）。
- 告警动作：SNS、EC2 stop / terminate / reboot / recover、Auto Scaling 策略。
- 自定义指标的维度与基数；PutMetricData 与 EMF；统计集拿不到百分位。
- CloudWatch（性能）、CloudTrail（API 审计）、AWS Config（配置合规）的区别。
