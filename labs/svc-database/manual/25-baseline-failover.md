---
step: baseline-failover
---

记录 before 的故障区间：运行器持续写入，并在第 30 秒重启 api（SQLite 档下“数据库故障”只能等同于应用进程重启）。

```bash {runsOn=workstation}
npm run exp -- database --label before --scenario failover --upload
```

::experiment{module=database id=failover label=before}

:::expected
报告中出现一段写失败区间，长度约等于 api 重启所需的时间。
:::

::checks
