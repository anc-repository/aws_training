---
step: poison
---

Use your workbench identity to send a "bad message" that the worker cannot parse straight into the job queue:

```bash {runsOn=workstation}
aws sqs send-message --queue-url "{{ var.queueUrl }}" --message-body 'not-a-job-envelope'
```

The worker does not delete it when it arrives (it cannot tell whether the message should be dropped); instead it retries later, backing off by receive count. After 3 failed receives, SQS moves it to the dead-letter queue. Check both queues every 30 seconds:

```bash {runsOn=workstation}
for i in $(seq 1 20); do
  aws sqs get-queue-attributes --queue-url "{{ var.dlqUrl }}" --attribute-names ApproximateNumberOfMessages --query Attributes --output text
  sleep 30
done
```

:::wait{typical=8 max=20}
After each receive, the message only becomes visible again after the visibility timeout (plus a backoff by receive count), so reaching the dead-letter queue takes a few minutes.
Meanwhile, open `/admin/jobs` to watch this message's receive count go up.
:::

:::expected
The dead-letter queue's available message count becomes 1; normal jobs in the source queue are not affected and keep being processed.
:::

::checks
