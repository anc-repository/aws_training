---
step: after-kill
---

记录 after：与 before 完全相同的“停服务 5 分钟”。这次停的也是 api 与 worker——本地评估器照样沉默，但 CloudWatch 收不到心跳点，
`app-heartbeat` 会进入 ALARM 并经 SNS 发邮件。

```bash {runsOn=workstation}
npm run exp -- monitoring --label after --scenario kill-test --param phase=service --fault-via ssm --instance-id {{ target.instanceId }} --upload
```

::experiment{module=monitoring id=kill-test label=after}

:::expected
`biz.local_alerts_during_outage` 仍为 0；`biz.cw_heartbeat_alarm` 为 1，`biz.cw_detect_sec` 约三四分钟；宕机期间邮箱收到 ALARM 邮件，
恢复几分钟后再收到 OK 邮件。
:::

:::saa{domain=resilient confusable="missing vs breaching"}
`TreatMissingData` 默认是 `missing`：没有数据时告警停在 INSUFFICIENT_DATA，不会通知。心跳类告警必须设为 `breaching`。
:::

::checks
