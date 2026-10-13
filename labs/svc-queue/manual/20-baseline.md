---
step: baseline
---

记录 before：突发上传 200 张小图，运行器在第 30 秒重启 api（模拟一次发布），然后等待队列排空并统计丢失的任务。

```bash {runsOn=workstation}
npm run exp -- queue --label before --scenario upload-burst --upload
```

::experiment{module=queue id=upload-burst label=before}

:::expected
报告中的 `biz.jobs_lost` 大于 0：重启时还在内存队列里的任务丢了。
:::

:::tip
运行期间打开实验机终端，用 `top` 看 api 进程与 worker 进程的 CPU：任务处理与 API 共用一台机器的 CPU。
:::

::checks
