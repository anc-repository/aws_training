---
step: enable-sqs
---

把任务队列切换到 Amazon SQS。模块会创建任务队列 `queue-jobs` 与死信队列 `queue-jobs-dlq`（只允许本队列重驱动），
然后先排空内存队列、**先重启 worker 再重启 api**，最后发一个探针任务确认链路通畅。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable queue --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable queue
```
:::

:::why
**为什么先重启 worker？** api 一旦切到 SQS 就会把新任务发进队列；如果此时 worker 还在读内存队列，这些任务就没人处理。
先让 worker 开始长轮询 SQS，再让 api 切换，任务不会落空。
:::

:::wait{typical=3 max=10}
部署两条队列通常不到一分钟；排空内存队列与两次重启需要再等一会儿。完成后在应用预览里上传一张照片，路径头里应出现 `queue=sqs:queued`。
:::

::console-link[在 SQS 控制台打开任务队列]{link=sqs.queue queueUrlEncoded="{{ var.queueUrl | url }}"}

:::expected
queue 的状态为“正常”；任务队列的重驱动策略指向死信队列、最大接收数 3、长轮询 20 秒、SSE-SQS 加密；死信队列保留 14 天。
:::

::checks
