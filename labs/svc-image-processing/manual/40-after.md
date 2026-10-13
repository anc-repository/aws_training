---
step: after
---

记录 after：与第 1 步完全相同的上传负载，这次缩略图由 Lambda 生成。

```bash {runsOn=workstation}
npm run exp -- image-processing --label after --scenario upload-burst --vus 20 --duration 60s --upload
```

::experiment{module=image-processing id=upload-burst label=after}

:::expected
complete 的 p95 降到几十毫秒量级；`host.cpu.p95` 明显下降；`biz.cold_starts` 大于 0（首批照片触发冷启动）；`biz.jobs_lost` 为 0。
:::

:::tip
加 `--ab` 可以在同一时段对比：一半照片带 `X-Compare-Bypass: image`，在 API 进程内当场处理，Lambda 随后的结果被幂等忽略。
:::

::checks
