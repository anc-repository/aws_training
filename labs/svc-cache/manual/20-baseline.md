---
step: baseline
---

记录 before：20 个并发用户在 120 秒内持续读时间线（运行器使用自己的实验用户，不影响你的相册）。

```bash {runsOn=workstation}
npm run exp -- cache --label before --scenario feed-read --vus 20 --duration 120s --upload
```

::experiment{module=cache id=feed-read label=before}

:::expected
每请求的数据库调用次数大于 0；cache 段全部是 `none`；错误数为 0。
:::

::checks
