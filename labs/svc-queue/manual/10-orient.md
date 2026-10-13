---
step: orient
---

先看清起点：任务进的是 api 进程的内存队列，缩略图由 worker 进程生成。

1. 在右侧“应用预览”上传几张照片：先出现灰色占位，几秒后才出现缩略图。
2. 打开 `/admin/jobs`：顶部写着“任务在 api 进程内存中排队（重启即丢）”。
3. 在工作台终端看一次上传请求的路径头：

```bash {runsOn=workstation}
curl -sk "https://{{ target.publicIp }}/api/capabilities" | jq '.modules | {queue: .queue.driver, imageProcessing: .["image-processing"].driver}'
```

:::expected
```json
{ "queue": "memory", "imageProcessing": "worker" }
```
上传请求的 `X-CloudAlbum-Path` 里有 `queue=memory:queued`。
:::

::checks
