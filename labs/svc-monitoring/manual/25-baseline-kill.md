---
step: baseline-kill
---

记录 before：故障脚本经 SSM 在实验机上停掉 api 与 worker，5 分钟后由 systemd 定时器自动启动回来。运行器轮询
`/api/health/live` 划出宕机窗口，恢复后读取 `alert_events`：宕机期间本地评估器有没有发出任何告警。

```bash {runsOn=workstation}
npm run exp -- monitoring --label before --scenario kill-test --param phase=service --fault-via ssm --instance-id {{ target.instanceId }} --upload
```

::experiment{module=monitoring id=kill-test label=before}

:::expected
`biz.local_alerts_during_outage` 为 0：worker 与 api 一起停了，评估器沉默；宕机期间没有站内信，也没有邮件。
:::

:::warning
宕机的 5 分钟里应用预览打不开，这是预期的。恢复由实验机上的 systemd 临时定时器负责，即使你中断了命令，服务也会按时启动。
:::

::checks
