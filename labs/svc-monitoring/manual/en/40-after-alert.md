---
step: after-alert
---

Record after: the same synthetic 5xx load, but this time the local evaluator and the CloudWatch alarm are timed side by side until both reach ALARM.

```bash {runsOn=workstation}
npm run exp -- monitoring --label after --scenario time-to-alert --upload
```

::experiment{module=monitoring id=time-to-alert label=after}

:::expected
`biz.local_detect_sec` is close to before (the local side keeps running as usual); `biz.cw_alarm` is 1 and `biz.cw_detect_sec` is in minutes.
Your mailbox then receives an email whose subject contains `ALARM: "cloudalbum-{{ session.env }}-app-5xx-rate"`.
:::

:::saa{domain=resilient confusable="周期 × 评估期 vs 出现延迟"}
Alarm delay ≈ period × the number of data points in M of N + the delay before metrics appear. Shorter periods (high-resolution metrics) are faster but cost more.
:::

::checks
