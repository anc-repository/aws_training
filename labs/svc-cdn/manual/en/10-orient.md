---
step: orient
---

First, confirm the starting point: right now Nginx on EC2 returns all content directly, and the responses show no trace of a CDN.

1. Open the album in the App preview on the right, and use the Network panel of your browser's developer tools to look at the response headers of any thumbnail: `X-CloudAlbum-Path` is there, `X-Cache` is not.
2. In the workbench terminal, request the lab instance's Elastic IP directly:

```bash {runsOn=workstation}
curl -skI "https://{{ target.publicIp }}/" | grep -iE '^(x-cache|x-cloudalbum-path|server):'
```

:::expected
```text
x-cloudalbum-path: entry=nginx;inst={{ target.instanceId }};az={{ target.az }}
```
There is no `x-cache` line, and `entry` is just `nginx`.
:::

:::why
`X-CloudAlbum-Path` is CloudAlbum's path header: `entry` records the chain of entry points the request went through. Once CloudFront is enabled, it becomes `cloudfront>nginx`.
:::

::checks
