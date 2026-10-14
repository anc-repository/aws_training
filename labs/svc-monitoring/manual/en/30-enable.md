---
step: enable
---

Wire in CloudWatch. The module creates the SNS topic `ops-alarms` with your email subscription, the dashboard `CloudAlbum-{{ session.env }}-Overview`, about 11 alarms
(status checks, CPU, CPU credits, memory, data disk, 5xx rate, p95, two heartbeats and a composite alarm) and the app policy; it also installs the CloudWatch agent on the lab instance
and drops in the memory and disk snippet. The app switches to "local + batched PutMetricData every 60 seconds".

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable monitoring --param AlertEmail={{ learner.inputs.notify-email }} --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable monitoring --param AlertEmail={{ learner.inputs.notify-email }}
```
:::

:::wait{typical=5 max=15}
Deploying the stack usually takes two or three minutes, and installing the agent and restarting the api and worker another minute or two. Right afterwards monitoring is a yellow “订阅未确认：告警只在控制台可见” (subscription not confirmed: alarms only visible in the console) —
that is waiting, not failure; confirm in your mailbox in the next step.
:::

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.monitoring | {driver, status, detail}'
systemctl is-active amazon-cloudwatch-agent
```

:::expected
`driver` is `cloudwatch`; the detail shows, in order, the time of the last successful upload, “Agent 运行中” (agent running) and the subscription status. The agent is `active`.
Under "Alarms" in the CloudWatch console you can see alarms prefixed `cloudalbum-{{ session.env }}-`, and `app-heartbeat`'s missing data treatment is "Treat missing data as bad (breaching threshold)".
:::

:::why
**Why are the only dimensions Route, Module, Driver, Outcome and Job?** Every dimension combination is a separately billed custom metric. Using requestId or userId
as a dimension would make the number of metrics explode; such high-cardinality fields belong only in logs or EMF properties.
:::

:::saa{domain=resilient confusable="指标告警 vs 复合告警"}
The `ec2-status-system` alarm has both the EC2 `recover` action and SNS; the composite alarm `app-unhealthy` can only notify, not run EC2 actions.
:::

::checks
