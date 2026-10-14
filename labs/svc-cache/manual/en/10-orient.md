---
step: orient
---

Open the timeline in the app preview, reload it a few times, and watch the performance badge on the page and the response headers.

```bash {runsOn=lab}
curl -s -o /dev/null -D - "http://127.0.0.1/api/feed?limit=24" | grep -iE "^(x-cloudalbum-path|server-timing):"
```

:::expected
The performance badge shows "未缓存" (not cached); the cache segment of the path header is `none`; the `database` entry of `Server-Timing` shows how many times this request queried the database (`xN`).
:::

::checks
