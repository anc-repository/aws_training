---
section: wrap-up
---

## 你做到了什么

- 让应用把同一份日志批量送进 CloudWatch Logs，本地文件照写：回滚没有数据缺口，实例没了日志还在。
- 量出了摄取延迟：本地立即可见，CloudWatch 秒级。
- 用 Logs Insights 聚合 5xx，看到了“扫描字节”这个计费依据；用指标过滤器把日志变成了指标。

## 考点回顾

- 日志组、日志流、保留期（默认永不过期）、KMS 加密；日志类别 Standard 与 Infrequent Access。
- EC2 上的日志需要 CloudWatch Agent 或 SDK；Lambda 日志自动进入。统一 CloudWatch Agent 同时采集日志与指标。
- 指标过滤器 → 指标 → 告警，不回溯；Logs Insights 按扫描量计费；订阅过滤器（Kinesis / Firehose / Lambda）近实时，导出到 S3 是批量。
- CloudWatch Logs（运行日志）与 CloudTrail（API 审计）的区别。
