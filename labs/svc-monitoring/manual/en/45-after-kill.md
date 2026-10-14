---
step: after-kill
---

Record after: exactly the same "stop the services for 5 minutes" as before. Again the api and worker stop — the local evaluator is silent as before, but CloudWatch receives no heartbeat points,
so `app-heartbeat` goes to ALARM and emails through SNS.

```bash {runsOn=workstation}
npm run exp -- monitoring --label after --scenario kill-test --param phase=service --fault-via ssm --instance-id {{ target.instanceId }} --upload
```

::experiment{module=monitoring id=kill-test label=after}

:::expected
`biz.local_alerts_during_outage` is still 0; `biz.cw_heartbeat_alarm` is 1 and `biz.cw_detect_sec` is about three or four minutes; an ALARM email arrives during the outage,
and an OK email a few minutes after recovery.
:::

:::saa{domain=resilient confusable="missing vs breaching"}
`TreatMissingData` defaults to `missing`: with no data, the alarm stops at INSUFFICIENT_DATA and does not notify. Heartbeat-style alarms must use `breaching`.
:::

::checks
