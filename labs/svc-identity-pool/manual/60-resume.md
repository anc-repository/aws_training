---
step: resume
---

断点续传：上传一个 24 MB 的文件（3 片），在第 2 片之前中断，然后续传。

```bash {runsOn=workstation}
npm run exp -- identity-pool --label after --scenario resume --upload
```

想真的断一次网：加 `--param pauseSec=30`，在脚本提示“模拟断网”之后断开工作台的网络、几秒后恢复。

::experiment{module=identity-pool id=resume label=after}

:::expected
`totalParts=3`、`partsBeforeInterruption=1`、`partsResent=2`、`onlyMissingResent=true`；服务端证据 `partsReportedBeforeResume=1`
来自 S3 的 `ListParts`，complete 之后照片在服务端为 `PROCESSING` / `READY`。
:::

:::tip
大文件上传的时间可能超过凭证有效期：浏览器在凭证剩余不到 5 分钟时重新请求 `/api/uploads/credentials`，分片遇到 `ExpiredToken`
时刷新后重试一次。没完成的分片上传由暂存桶的生命周期规则 1 天后自动中止。
:::

::checks
