---
step: mem-visibility
---

EC2 only provides metrics visible from the virtualization layer. First look for this lab instance's memory metric in CloudWatch:

```bash {runsOn=workstation}
aws cloudwatch list-metrics --namespace AWS/EC2 --dimensions Name=InstanceId,Value={{ target.instanceId }} --query "Metrics[].MetricName" --output text
aws cloudwatch list-metrics --namespace CWAgent --metric-name mem_used_percent --dimensions Name=InstanceId,Value={{ target.instanceId }}
```

Then occupy 256 MiB of memory for 5 minutes through the shared fault injection and compare three curves:

```bash {runsOn=workstation}
npm run exp -- monitoring --label after --scenario mem-visibility --param mib=256 --upload
```

::experiment{module=monitoring id=mem-visibility label=after}

:::expected
`AWS/EC2` has CPUUtilization, NetworkIn, StatusCheckFailed and so on, but no memory; `CWAgent` has `mem_used_percent`.
In the report, `biz.ec2_mem_points` is 0, `biz.cwagent_mem_points` is above 0, and `biz.local_mem_delta_pct` is close to CWAgent's increase.
:::

:::saa{domain=performance confusable="详细监控 vs Agent 指标"}
Detailed monitoring only raises EC2 metric resolution from 5 minutes to 1 minute and adds no memory or disk utilization; those must be sent by an agent inside the OS.
:::

::checks
