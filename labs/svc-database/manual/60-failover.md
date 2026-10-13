---
step: failover
---

故障转移：运行器持续写入，并在第 30 秒执行 `aws rds reboot-db-instance --force-failover`（故障脚本在工作台用你的身份执行，需要实例 ID）。

```bash {runsOn=workstation}
export DB_INSTANCE_ID={{ var.dbInstanceId }}
npm run exp -- database --label after --scenario failover --upload
```

::experiment{module=database id=failover label=after}

:::wait{typical=3 max=10}
故障转移期间实例状态为 rebooting；完成后原来的备库成为主库，端点的 DNS 指向新主库。
:::

:::expected
报告中出现一段写失败区间，随后应用自动重连；页面顶部短暂显示“数据库重连中”。主库换到了第 4 步记录的备库 AZ。
:::

:::tip
故障转移后主库与实验机可能不在同一个 AZ，单次查询的延迟会略升——这是跨 AZ 的网络往返，不是故障。
:::

::checks
