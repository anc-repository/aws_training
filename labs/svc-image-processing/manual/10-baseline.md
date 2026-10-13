---
step: baseline
---

记录 before：20 个并发用户在 60 秒内持续上传 4000×3000 的 JPEG，每张都走完“建档 → PUT 到 S3 → complete → 轮询直到 READY”。

```bash {runsOn=workstation}
npm run exp -- image-processing --label before --scenario upload-burst --vus 20 --duration 60s --upload
```

::experiment{module=image-processing id=upload-burst label=before}

:::expected
complete 接口的 p95 在秒级；`host.cpu.p95` 接近 100%；缩略图就绪时间约等于 complete 的耗时。
:::

:::tip
想同时看“邻居影响”，可以额外运行 `npm run exp -- image-processing --label before --scenario neighbor --upload`（选做）：
同样的上传负载下每秒读 5 次时间线，看 `GET /api/feed` 的 p95。enable 之后同一场景只能记录 after。
:::

::checks
