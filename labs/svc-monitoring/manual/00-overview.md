---
section: overview
---

## 背景

L0 的告警由 worker 进程里的**本地告警评估器**判断：它每 30 秒读一次 LabMetricsStore 写进数据库的分钟汇总与主机采样，
按 `/etc/cloudalbum/alerts.yaml` 的规则（5xx 比率、p95、内存、数据盘、api 心跳）决定 OK / ALARM，状态变化时给管理员写站内信、
经 EmailPort 发邮件。问题在于：评估器和被监控的应用跑在同一台机器上——worker 挂了没人评估，实例挂了没人报警；
EC2 默认也没有内存指标。

这张卡片让同样的指标再批量上报一份到 Amazon CloudWatch（`cloudwatch = local + 批量上报`，本地一侧照常工作），
CloudWatch Agent 补上内存与磁盘，告警由 AWS 侧评估，经模块自带的 SNS 主题 `ops-alarms` 发邮件。

:::why
告警系统要与被监控对象**解耦**：心跳指标每分钟一个点，告警把“没有数据”视为违规（`TreatMissingData=breaching`），
进程死亡、实例停止时数据缺失，告警照样进入 ALARM。本地评估器做不到这一点——它自己也在那台机器上。
:::

## 对比实验预告

### 告警时延（monitoring/time-to-alert，必做）

- **没有 CloudWatch**：本地评估器每 30 秒一次，秒级到数十秒就进入 ALARM；送达靠站内信与 outbox。
- **有了 CloudWatch**：同一批 5xx，CloudWatch 告警要 1 分钟周期 × 3 of 5 个数据点，再加上 60 秒批量上报与指标出现延迟，是分钟级。
- **你会在哪里看到**：报告中的 `biz.local_detect_sec` 与 `biz.cw_detect_sec`——都是服务端记录的状态变化时刻（本地 `alert_events`、
  CloudWatch 告警历史），不是客户端看到的响应。
- **如果结果不符合预期**：CloudWatch 一侧没有告警时，先看 monitoring 是否为“正常”（上报是否落后），再看实验时长是否足够。

### 宕机（monitoring/kill-test，必做）

- **没有 CloudWatch**：停掉 api 与 worker 的 5 分钟里，本地评估器完全沉默，一条告警都没有。
- **有了 CloudWatch**：同样停服务，`app-heartbeat` 在三四分钟后进入 ALARM，邮件照常送达。
- **你会在哪里看到**：`biz.local_alerts_during_outage`（应为 0）与 `biz.cw_heartbeat_alarm`；邮箱里的 ALARM 邮件。

## 平台模式说明

对比实验在工作台运行；停服务的故障脚本经 SSM Run Command 投递到实验机（`--fault-via ssm`），你不需要登录实验机。
选做的“停实例”会让平台管理通道离线几分钟，步骤声明了预期中断，界面显示“预期中断”而不是故障。
