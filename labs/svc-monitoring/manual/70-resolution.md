---
step: resolution
---

（选做）同一段 3 分钟的 CPU 尖峰，在本地 10 秒样本、EC2 基础监控（5 分钟）下各是什么样子：

```bash {runsOn=workstation}
npm run exp -- monitoring --label after --scenario resolution --fault-via ssm --instance-id {{ target.instanceId }} --upload
```

::experiment{module=monitoring id=resolution label=after}

想对比详细监控，就开启它再做一次（详细监控按实例计费，做完一定改回）：

```bash {runsOn=workstation}
scripts/module enable monitoring --param AlertEmail={{ learner.inputs.notify-email }} --param DetailedMonitoring=true
npm run exp -- monitoring --label after --scenario resolution --fault-via ssm --instance-id {{ target.instanceId }} --upload
scripts/module enable monitoring --param AlertEmail={{ learner.inputs.notify-email }} --param DetailedMonitoring=false
```

:::expected
本地 `host.loadavg1` 在尖峰期间有十几个点；基础监控下 `biz.ec2_points_300` 只有一两个点，尖峰被平均成小坡；
详细监控下 `biz.ec2_points_60` 明显更多。
:::

::checks
