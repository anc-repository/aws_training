---
step: resolution
---

(Optional) See what the same 3-minute CPU spike looks like with the local 10-second samples and with EC2 basic monitoring (5 minutes):

```bash {runsOn=workstation}
npm run exp -- monitoring --label after --scenario resolution --fault-via ssm --instance-id {{ target.instanceId }} --upload
```

::experiment{module=monitoring id=resolution label=after}

To compare with detailed monitoring, turn it on and run it again (detailed monitoring is billed per instance, so be sure to turn it back off afterwards):

```bash {runsOn=workstation}
scripts/module enable monitoring --param AlertEmail={{ learner.inputs.notify-email }} --param DetailedMonitoring=true
npm run exp -- monitoring --label after --scenario resolution --fault-via ssm --instance-id {{ target.instanceId }} --upload
scripts/module enable monitoring --param AlertEmail={{ learner.inputs.notify-email }} --param DetailedMonitoring=false
```

:::expected
The local `host.loadavg1` has a dozen or so points during the spike; with basic monitoring `biz.ec2_points_300` has only one or two points and the spike is averaged into a gentle slope;
with detailed monitoring `biz.ec2_points_60` has clearly more.
:::

::checks
