---
step: poison
---

用你的工作台身份直接往任务队列里发一条 worker 无法解析的“坏消息”：

```bash {runsOn=workstation}
aws sqs send-message --queue-url "{{ var.queueUrl }}" --message-body 'not-a-job-envelope'
```

worker 收到后不会删除它（不能确定是否该丢弃），而是按接收次数延后再试；接收 3 次仍失败，SQS 把它移入死信队列。每 30 秒看一次两条队列：

```bash {runsOn=workstation}
for i in $(seq 1 20); do
  aws sqs get-queue-attributes --queue-url "{{ var.dlqUrl }}" --attribute-names ApproximateNumberOfMessages --query Attributes --output text
  sleep 30
done
```

:::wait{typical=8 max=20}
每次接收后要等可见性超时（并按接收次数退避）才会再次可见，所以进入死信队列需要几分钟。
期间打开 `/admin/jobs`，可以看到这条消息的接收次数在增加。
:::

:::expected
死信队列的可用消息数变为 1；源队列里的正常任务不受影响，继续被处理。
:::

::checks
