---
section: overview
---

## Background

You bulk-upload dozens of photos, the API quickly returns "upload succeeded", and thumbnails are generated slowly in the background. This is the start state's "async on the local tier": jobs wait in the api process's in-memory queue
and a worker process handles them. But as soon as a release restarts the api, every queued job disappears: thumbnails come back within minutes through the reconciliation job, but the "upload succeeded" notification email is really lost.
This card puts jobs into Amazon SQS so that whether a job still exists no longer depends on which process is alive.

:::why
SQS standard queues deliver at least once: a received message is not deleted right away; it is hidden from other consumers for the visibility timeout, and the worker deletes it only after it finishes.
If the worker is killed halfway, the message reappears after the timeout and the next receive carries on; duplicate executions are absorbed by the app's deduplication table `processed_jobs`.
:::

## Comparison experiments

### Burst upload + killed process (queue/upload-burst, required)

- **Without SQS (memory local tier)**: jobs exist only in the api process's memory. Restart the api at 30 s and queued and in-flight jobs disappear together.
- **With SQS**: the same burst upload, but at 30 s the worker is killed outright with `kill -9`. Undeleted messages reappear after the visibility timeout and the restarted worker carries on.
- **Where you see it**: the number of lost jobs in the comparison report (`biz.jobs_lost`) drops from above 0 to 0; the EC2 CPU graph changes from a spike to a plateau, and draining takes longer;
  the response header `X-CloudAlbum-Path` changes from `queue=memory:queued` to `queue=sqs:queued`.
- **If the results are not what you expect**: first confirm that both the before and the after runs used the worker tier; then confirm that the after run killed the worker, not the api.

## Platform mode notes

The comparison experiments run on the workbench; the fault at 30 s (restarting the api, `kill -9` on the worker) is sent to the lab instance by the runner through SSM Run Command, so you do not need to sign in to the lab instance.
