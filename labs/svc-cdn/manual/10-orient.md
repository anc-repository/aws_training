---
step: orient
---

先确认起点：现在所有内容都由 EC2 的 Nginx 直接返回，响应里没有任何 CDN 的痕迹。

1. 在右侧“应用预览”打开相册，用浏览器开发者工具的 Network 面板看任意一张缩略图的响应头：有 `X-CloudAlbum-Path`，没有 `X-Cache`。
2. 在工作台终端里直接请求实验机的弹性 IP：

```bash {runsOn=workstation}
curl -skI "https://{{ target.publicIp }}/" | grep -iE '^(x-cache|x-cloudalbum-path|server):'
```

:::expected
```text
x-cloudalbum-path: entry=nginx;inst={{ target.instanceId }};az={{ target.az }}
```
没有 `x-cache` 这一行；`entry` 只有 `nginx`。
:::

:::why
`X-CloudAlbum-Path` 是 CloudAlbum 的路径头：`entry` 记录请求经过的入口链。启用 CloudFront 后，它会变成 `cloudfront>nginx`。
:::

::checks
