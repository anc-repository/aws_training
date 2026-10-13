---
step: orient
---

在应用预览里打开时间线，刷新几次，留意页面上的性能徽章与响应头。

```bash {runsOn=lab}
curl -s -o /dev/null -D - "http://127.0.0.1/api/feed?limit=24" | grep -iE "^(x-cloudalbum-path|server-timing):"
```

:::expected
性能徽章显示“未缓存”；路径头的 cache 段是 `none`；`Server-Timing` 的 `database` 项显示这次请求查了几次库（`xN`）。
:::

::checks
