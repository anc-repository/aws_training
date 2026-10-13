---
step: tour
---

在应用预览里用一遍相册，同时打开浏览器开发者工具的 Network 面板：

1. 注册一个账号，打开“我的邮件”（`/me/outbox`）中的验证邮件完成验证（L0 不真正发信）。
2. 上传几张照片，等缩略图生成；点赞、评论。
3. 在 Network 面板中任选一个 `/api/` 请求，看响应头 `X-CloudAlbum-Path` 与 `Server-Timing`。

:::expected
`X-CloudAlbum-Path` 中 `entry=nginx`，存储段是本地磁盘、缩略图段是 `inline`；`Server-Timing` 给出各端口的耗时。
所有功能都在这一台机器上完成。
:::

:::tip
`X-CloudAlbum-Path` 是后面每张卡片的“证据”：启用一个模块后，对应的段会从本地实现变成 AWS 服务。
:::

::checks
