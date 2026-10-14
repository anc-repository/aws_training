---
step: orient
---

Browse the album in the app preview, then check where the database lives from the lab instance terminal:

```bash {runsOn=lab}
curl -s -o /dev/null -D - "http://127.0.0.1/api/feed?limit=24" | grep -iE "^(x-cloudalbum-path|server-timing):"
curl -s http://127.0.0.1/api/capabilities | jq ".modules.database | {driver, status, detail}"
```

:::expected
The database segment of the path header is `sqlite`; the admin page shows "SQLite（EBS 文件）" (SQLite (EBS file)).
:::

:::why
**Something to think about**: what happens to the database if you stop this EC2 instance? SQLite lives and dies with EC2 — this step does not actually stop it (that would cut the platform's management channel);
keep the question in mind and compare it with the failover result in step 7.
:::

::checks
