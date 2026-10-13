---
step: baseline
---

记录 before：10 个并发、每张 5 MB、持续 60 秒的上传压测，同时每秒读几次时间线，观察上传对其他接口的影响。

```bash {runsOn=workstation}
npm run exp -- storage --label before --scenario upload-burst --param fileMb=5 --duration 60s --upload
```

::experiment{module=storage id=upload-burst label=before}

:::tip
模块文档的默认参数是 20 MB、120 秒。卡片改为 5 MB、60 秒：L0 的 before 会把原图写进 20 GiB 的数据卷，默认参数可能逼近磁盘阈值，污染后续步骤；方向与数量级的结论不受影响。
:::

::checks
