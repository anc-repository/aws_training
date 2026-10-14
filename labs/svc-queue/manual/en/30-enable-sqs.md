---
step: enable-sqs
---

Switch the job queue to Amazon SQS. The module creates the job queue `queue-jobs` and the dead-letter queue `queue-jobs-dlq` (which only allows redrive from this queue),
then drains the in-memory queue, **restarts the worker first and then the api**, and finally sends a probe job to confirm the path works.

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable queue --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable queue
```
:::

:::why
**Why restart the worker first?** Once the api switches to SQS it sends new jobs to the queue; if the worker is still reading the in-memory queue at that moment, nobody processes those jobs.
Let the worker start long polling SQS first, then switch the api, and no job falls through the cracks.
:::

:::wait{typical=3 max=10}
Deploying the two queues usually takes less than a minute; draining the in-memory queue and the two restarts take a little longer. When it finishes, upload a photo in the App preview: the path header should show `queue=sqs:queued`.
:::

::console-link[Open the job queue in the SQS console]{link=sqs.queue queueUrlEncoded="{{ var.queueUrl | url }}"}

:::expected
queue is Healthy; the job queue's redrive policy points to the dead-letter queue with maximum receives 3, long polling is 20 seconds, and SSE-SQS encryption is on; the dead-letter queue keeps messages for 14 days.
:::

::checks
