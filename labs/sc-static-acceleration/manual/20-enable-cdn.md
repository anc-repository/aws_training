---
step: enable-cdn
---

创建分配并把媒体源站设为 S3。`scripts/module` 分三阶段完成：以 EC2 为源部署分配（含缓存策略、响应头策略、去掉 `/media` 前缀的 CloudFront Function、
8080 源站监听器与安全组）→ 把分配 ARN 注入 storage 栈，生成 OAC 桶策略 → 把 `/media/*` 行为的源站切到 S3。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_MEDIA_ORIGIN=s3 --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_MEDIA_ORIGIN=s3
```
:::

:::wait{typical=8 max=25}
分配状态从“正在部署”变为“已启用”需要几分钟；三阶段中分配会更新两次。
:::

在控制台对照查看行为、缓存策略与源站：

::console-link[打开分配]{link=cloudfront.distribution distributionId="{{ var.distributionId }}"}

:::expected
cdn 的状态为“正常”；`/media/*` 行为的源是 `s3-media`（带 OAC），其余行为回源到实验机；经分配请求 `/api/health/live` 时路径头以 `entry=cloudfront>nginx` 开头。
:::

:::saa{domain=performance confusable="缓存策略 vs 源请求策略"}
缓存策略决定缓存键与 TTL；源请求策略决定回源时额外带哪些头、Cookie 与查询参数（不进入缓存键）；响应头策略在边缘给响应加头（CORS、安全头）。
:::

::checks
