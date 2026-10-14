---
step: baseline-kill
---

Record before: the fault script stops the api and worker on the lab instance through SSM, and a systemd timer starts them again automatically after 5 minutes. The runner polls
`/api/health/live` to mark the outage window, and after recovery reads `alert_events`: did the local evaluator raise any alarm during the outage?

```bash {runsOn=workstation}
npm run exp -- monitoring --label before --scenario kill-test --param phase=service --fault-via ssm --instance-id {{ target.instanceId }} --upload
```

::experiment{module=monitoring id=kill-test label=before}

:::expected
`biz.local_alerts_during_outage` is 0: the worker stopped together with the api, so the evaluator is silent; there are no in-app messages and no emails during the outage.
:::

:::warning
The App preview will not open during the 5-minute outage; this is expected. A temporary systemd timer on the lab instance handles recovery, so the services start on time even if you interrupt the command.
:::

::checks
