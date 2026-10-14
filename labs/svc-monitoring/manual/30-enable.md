---
step: enable
---

接入 CloudWatch。模块会创建：SNS 主题 `ops-alarms` 与你的邮件订阅、仪表板 `CloudAlbum-{{ session.env }}-Overview`、约 11 个告警
（状态检查、CPU、CPU 积分、内存、数据盘、5xx 比率、p95、两个心跳、复合告警）、应用策略；并在实验机上安装 CloudWatch Agent，
投放内存与磁盘片段。应用改为“本地 + 每 60 秒批量 PutMetricData”。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable monitoring --param AlertEmail={{ learner.inputs.notify-email }} --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable monitoring --param AlertEmail={{ learner.inputs.notify-email }}
```
:::

:::wait{typical=5 max=15}
部署栈通常两三分钟，安装 Agent 与重启 api、worker 再要一两分钟。完成后 monitoring 先是黄色“订阅未确认：告警只在控制台可见”——
这是等待，不是失败；下一步去邮箱确认即可。
:::

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.monitoring | {driver, status, detail}'
systemctl is-active amazon-cloudwatch-agent
```

:::expected
`driver` 为 `cloudwatch`；detail 依次写着最近一次上报成功的时间、“Agent 运行中”、订阅状态。Agent 为 `active`。
在 CloudWatch 控制台的“告警”里能看到前缀 `cloudalbum-{{ session.env }}-` 的告警，`app-heartbeat` 的缺失数据处理是“视为违规”。
:::

:::why
**维度为什么只有 Route、Module、Driver、Outcome、Job？** 每一种维度组合都是一个单独计费的自定义指标。把 requestId、userId
当维度会让指标数爆炸；这类高基数字段只能放在日志或 EMF 属性里。
:::

:::saa{domain=resilient confusable="指标告警 vs 复合告警"}
`ec2-status-system` 告警同时挂了 EC2 `recover` 动作与 SNS；复合告警 `app-unhealthy` 只能发通知，不能执行 EC2 动作。
:::

::checks
