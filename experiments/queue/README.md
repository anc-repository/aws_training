# queue 实验（有 / 无 SQS）

设计：[docs/modules/04-compute-async.md#queue](../../docs/modules/04-compute-async.md) 第 5 节。

| 标签 | 前置条件 | 故障 |
|---|---|---|
| `l0` | `queue.driver=sync`、`image-processing.driver=inline`（参照） | — |
| `before` | `queue.driver=memory`、`image-processing.driver=worker` | 第 30 秒 `faults/restart-api.sh` |
| `after` | `queue.driver=sqs`、`image-processing.driver=worker`、`queue.status=ok/degraded` | 第 30 秒 `faults/kill-worker.sh` |

## upload-burst

```bash
npm run exp -- queue --label l0     --scenario upload-burst --vus 10 --duration 60s
scripts/module enable queue --driver memory && scripts/module enable image-processing --driver worker
npm run exp -- queue --label before --scenario upload-burst --fault-via ssh --ssh ec2-user@<EIP>
scripts/module enable iam && scripts/module enable queue          # 或 scripts/module profile apply single/queue
npm run exp -- queue --label after  --scenario upload-burst --fault-via ssh --ssh ec2-user@<EIP>
npm run exp:report -- queue                                       # memory 对 sqs
npm run exp:report -- queue --before <l0 那轮的文件> --after latest
npm run exp -- queue --label after --scenario upload-burst --ab   # X-Compare-Bypass: queue：一半任务当场执行
```

上传 `count`（默认 200）张小图，记录 `POST /api/photos/:id/complete` 的延迟，然后轮询到全部 READY（上限 `drainTimeoutSec`，默认 600 秒，
SQS 可见性超时为 120 秒）。超过上限仍未就绪的计入 `biz.jobs_lost`。`shell-access=ssm` 时用 `--fault-via ssm --instance-id i-…`。

预期：memory / sqs 的接口延迟都只含入队（几十毫秒量级）；memory 档重启 api 后在途任务丢失（就绪时间被拉长到对账任务的分钟级，
通知类任务真的丢了）；sqs 档 kill -9 worker 后任务在可见性超时后重投，`jobs_lost=0`。

## poison（手工）

用部署者凭证往主队列发一条 `name` 合法、payload 错误的消息，每 10 秒查一次源队列与 DLQ：

```bash
QURL=$(aws sqs get-queue-url --queue-name cloudalbum-<env>-queue-jobs --query QueueUrl --output text)
# 队列 URL 也可从 queue.env 的 SQS_QUEUE_URL（栈输出 EnvSqsQueueUrl）取得；DLQ 为 cloudalbum-<env>-queue-jobs-dlq
aws sqs send-message --queue-url "$QURL" --message-body '{"v":1,"name":"email.send","payload":"not-an-object"}' \
  --message-attributes 'name={DataType=String,StringValue=email.send}'
watch -n 10 "aws sqs get-queue-attributes --queue-url $QURL --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible"
```

预期：被接收 3 次（每次间隔可见性超时 + 退避）后进入 DLQ，分钟量级。`/admin/jobs` 的 DLQ 列表显示接收次数与最后一次错误。

## dlq-replay（手工）

`aws sqs start-message-move-task --source-arn <DLQ ARN>` 把消息移回源队列（handler 没修时会再次进入 DLQ），
或在 `/admin/jobs` 点“导出到 failed_jobs”后在本地重放。
