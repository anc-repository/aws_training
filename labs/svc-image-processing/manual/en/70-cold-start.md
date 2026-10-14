---
step: cold-start
---

(Optional) Cold starts: leave the function idle for 15 minutes, upload 1 photo, then 5 more in a row, and count `Init Duration` with CloudWatch Logs Insights.
Skip this step if less than 30 minutes remain.

```bash {runsOn=workstation}
aws logs start-query --log-group-name "{{ var.logGroup }}" --start-time $(( $(date +%s) - 3600 )) --end-time $(date +%s) --query-string 'filter @type = "REPORT" | stats count(@initDuration) as coldStarts, avg(@initDuration) as avgInit, pct(@duration, 95) as p95 by bin(5m)'
```

Read the results with the returned `queryId`:

```bash {runsOn=workstation}
aws logs get-query-results --query-id <the queryId returned by the previous command>
```

:::tip
To compare with provisioned concurrency: publish a version, configure 1 unit of provisioned concurrency, repeat the measurement above, and **delete it immediately**. Provisioned concurrency is billed by time and costs money for as long as it is configured.
:::

:::expected
The first photo after the idle period has an `Init Duration` (a few hundred milliseconds); the photos uploaded right after it, one by one, reuse the execution environment and have no `Init Duration`.
:::

::checks
