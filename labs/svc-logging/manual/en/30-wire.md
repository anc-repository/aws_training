---
step: wire
---

Wire in CloudWatch Logs. The module creates the log groups `/cloudalbum/{{ session.env }}/app` and `/nginx` (14-day retention), the metric filters
`AppErrors`, `Nginx5xx` and `AuthLoginFailed` (namespace `CloudAlbum/Logs`) and four saved Logs Insights queries, attaches the instance policy and restarts the api and worker.

:::method{kind=script default}
Preview the changes first (`LOG_CW_SHIPPER=sdk`: the app batch-ships the logs itself):

```bash {runsOn=workstation}
scripts/module enable logging --param RetentionInDays=14 --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable logging --param RetentionInDays=14
```
:::

:::wait{typical=3 max=10}
Deploying the log groups and metric filters takes less than a minute; after the restart the shipper sends a batch every 2 seconds (`LOG_CW_FLUSH_MS`). The platform then makes a request to the lab instance and confirms that this instance's
`<instance ID>/access` log stream appears in the Nginx log group.
:::

::console-link[Open the Nginx log group in the CloudWatch console]{link=logs.group logGroupEncoded="{{ var.nginxGroup | url }}"}

:::expected
logging's driver is `cloudwatch` and it is healthy, with a detail like “CloudWatch Logs · /cloudalbum/{{ session.env }}/app · 流 <实例 ID>/api …” (stream <instance ID>/api);
both log groups have a 14-day retention; local files are still written.
:::

:::saa{domain=cost confusable="保留期"}
Log groups **never expire** by default, so storage charges only grow; always set a retention period. The log class (Standard / Infrequent Access) cannot be changed after creation; this module uses Standard throughout.
:::

::checks
