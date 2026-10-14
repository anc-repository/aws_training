---
step: mem-visibility
---

EC2 只提供虚拟化层看得到的指标。先在 CloudWatch 里找本实验机的内存指标：

```bash {runsOn=workstation}
aws cloudwatch list-metrics --namespace AWS/EC2 --dimensions Name=InstanceId,Value={{ target.instanceId }} --query "Metrics[].MetricName" --output text
aws cloudwatch list-metrics --namespace CWAgent --metric-name mem_used_percent --dimensions Name=InstanceId,Value={{ target.instanceId }}
```

再经共享故障注入占用 256 MiB 内存 5 分钟，对比三条曲线：

```bash {runsOn=workstation}
npm run exp -- monitoring --label after --scenario mem-visibility --param mib=256 --upload
```

::experiment{module=monitoring id=mem-visibility label=after}

:::expected
`AWS/EC2` 里有 CPUUtilization、NetworkIn、StatusCheckFailed 等，没有内存；`CWAgent` 里有 `mem_used_percent`。
报告中 `biz.ec2_mem_points` 为 0，`biz.cwagent_mem_points` 大于 0，`biz.local_mem_delta_pct` 与 CWAgent 的升幅相近。
:::

:::saa{domain=performance confusable="详细监控 vs Agent 指标"}
详细监控只把 EC2 指标的粒度从 5 分钟提高到 1 分钟，并不增加内存、磁盘使用率；这两类指标必须由操作系统内的 Agent 上报。
:::

::checks
