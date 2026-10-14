---
step: orient
---

First, get a clear view of the starting point: jobs go into the api process's in-memory queue, and the worker process generates thumbnails.

1. Upload a few photos in the App preview on the right: a grey placeholder appears first, and the thumbnail shows up a few seconds later.
2. Open `/admin/jobs`: the top says “任务在 api 进程内存中排队（重启即丢）” (jobs wait in the api process's memory and are lost on restart).
3. In the workbench terminal, look at the path header of an upload request:

```bash {runsOn=workstation}
curl -sk "https://{{ target.publicIp }}/api/capabilities" | jq '.modules | {queue: .queue.driver, imageProcessing: .["image-processing"].driver}'
```

:::expected
```json
{ "queue": "memory", "imageProcessing": "worker" }
```
The upload request's `X-CloudAlbum-Path` contains `queue=memory:queued`.
:::

::checks
