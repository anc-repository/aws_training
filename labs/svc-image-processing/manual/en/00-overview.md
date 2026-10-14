---
section: overview
---

## Background

At L0, sharp generates thumbnails synchronously inside the "upload complete" request (inline, concurrency 2). When 200 photos are uploaded at once, requests queue on a semaphore, both vCPUs are maxed out,
and browsing the timeline slows down too — requests at the end of the queue may even be cut off by Nginx with a 504. With this card, as soon as an original lands in S3, EventBridge invokes Lambda asynchronously to make the thumbnail;
EC2 only writes the result back to the database.

:::why
Lambda cannot read the lab instance's EBS or SQLite: once the computing moves to Lambda, the input has to be in S3 and the result has to come back over the network.
That is why the start state already provides storage(s3), and the write-back uses this module's own result queue (no inbound traffic needed at all).
:::

## Comparison experiments

### Upload burst (image-processing/upload-burst, required)

- **Without Lambda (inline)**: the complete API takes as long as sharp does — seconds at 20 concurrent users; EC2's CPU is maxed out.
- **With Lambda**: complete only does one database update, in the tens of milliseconds; EC2's CPU is almost a flat line; most thumbnails are ready within a few seconds.
- **Where you will see it**: the p95 of `POST /api/photos/complete`, `host.cpu.p95` and `biz.photo_time_to_ready.p95` in the comparison report;
  the `X-CloudAlbum-Path` response header changes from `image-processing=inline` to `image-processing=lambda:async`.
- **If the results are not what you expect**: check that image-processing's driver was lambda and healthy during the after run; the first photos include cold starts, so their time to ready is longer.

### Failure paths (image-processing/failures, required)

A corrupt JPEG is a permanent error: the function writes back FAILED directly, without retrying and without using the failure queue.

## Platform mode notes

The comparison experiments run on the workbench. `scripts/module` packages the function's deployment package and uploads it to the toolchain bucket the platform created in advance, so you do not need to install any packaging tools.
