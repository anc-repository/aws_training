# image-processing 实验（有 / 无 Lambda）

设计：[docs/modules/04-compute-async.md#image-processing](../../docs/modules/04-compute-async.md) 第 5 节。

| 标签 | 前置条件 |
|---|---|
| `before` | `image-processing.driver=inline` |
| `worker-memory` | `image-processing.driver=worker`、`queue.driver=memory` |
| `worker-sqs` | `image-processing.driver=worker`、`queue.driver=sqs` |
| `after` | `image-processing.driver=lambda`、`image-processing.status=ok/degraded`、`storage.driver=s3` |

## upload-burst

```bash
npm run exp -- image-processing --label before --scenario upload-burst --vus 20 --duration 60s
scripts/module enable queue --driver memory && scripts/module enable image-processing --driver worker
npm run exp -- image-processing --label worker-memory --scenario upload-burst
scripts/module enable iam && scripts/module enable queue
npm run exp -- image-processing --label worker-sqs --scenario upload-burst
scripts/module enable image-processing --with-deps
npm run exp -- image-processing --label after --scenario upload-burst
npm run exp -- image-processing --label after --scenario upload-burst --ab          # 一半照片 X-Compare-Bypass: image
npm run exp:report -- image-processing --before latest --after latest
npm run exp:report -- image-processing --pair worker-sqs,after
```

默认 4000×3000 的噪声 JPEG（`--param width= height=`），走完“建档 → PUT → complete → 轮询直到 READY”。
观察：complete 的 p95（inline 为 sharp 处理时间）、`biz.photo_time_to_ready.*`（readyAt − createdAt）、`biz.cold_starts`（`processedBy.coldStart`）、
`host.cpu.p95` 与 `host.event_loop_delay.p99`（lambda 档 EC2 CPU 几乎不动）。`--ab` 时旁路的那一半 Lambda 仍会处理，结果被幂等忽略。

## neighbor

```bash
npm run exp -- image-processing --label before --scenario neighbor
npm run exp -- image-processing --label after  --scenario neighbor
npm run exp:report -- image-processing --experiment neighbor
```

与 upload-burst 相同的负载，同时以 `feedRps`（默认 5）次 / 秒读时间线；看 `GET /api/feed` 的 p95 / p99（`scenario.feedUnderLoad`）。

## failures

```bash
npm run exp -- image-processing --label after --scenario failures --param count=3
```

上传损坏的 JPEG：应很快变成 FAILED（`scenario.notFailed=0`），不重试、不进失败队列。“暂时错误”部分需要改函数配置：
`aws lambda update-function-configuration --function-name <ThumbFunctionName> --environment 'Variables={…,FAULT_RATE=0.5}'`，
上传 10 张后观察重试、`FailureQueue` 中的消息与对账任务；做完还原环境变量。

## cold-start（手工）

闲置 15 分钟后上传 1 张、再连续上传 5 张（可用 `--scenario upload-burst --param count=1` / `count=5`），在 CloudWatch Logs Insights 查询：

```
filter @type = "REPORT"
| stats count(@initDuration) as coldStarts, avg(@initDuration) as avgInit, pct(@duration, 95) as p95 by bin(5m)
```

可选：临时配置预置并发再测一次，测完立即删除（按时长计费）。

## throttle（手工）

`aws lambda put-function-concurrency --function-name <函数> --reserved-concurrent-executions 0`（等于暂停），上传 10 张，等 120 秒后
`aws lambda delete-function-concurrency`。观察 `Throttles` 上升、照片停在 PROCESSING，恢复后异步队列重试，照片陆续 READY。
“限流到 2 个并发”用 buffer-queue 变体：`scripts/module enable image-processing --param Trigger=buffer-queue --param MaxConcurrency=2` 后跑 upload-burst。

## cost（手工）

从 REPORT 日志汇总 Billed Duration 与内存，按“请求数 × 单价 + Σ(计费时长 × 内存 GB) × GB-秒单价”计算每千张图片的费用；
单价从官方定价页抄入，本仓库不内置任何价格。对照：EC2 是固定成本，与张数无关。
