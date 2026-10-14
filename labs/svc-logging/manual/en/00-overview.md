---
section: overview
---

## Background

At L0, logs only live on the EBS data volume: the api and worker write JSON lines with pino to `/var/lib/cloudalbum/logs/api.log` and `worker.log`, and Nginx writes
`nginx-access.json`. To investigate a problem you have to sign in to this instance and grep the files one by one; with several instances you look at each one separately, the logs vanish when an instance is replaced, and Lambda logs are not local at all.
This card has the app batch-ship **the same** structured logs to Amazon CloudWatch Logs while still writing the local files, so a rollback leaves no gap in the data.

:::why
Logs written to files on EC2 do not reach CloudWatch Logs by themselves: either the app calls `PutLogEvents` itself (this module's default sdk method — the api and worker
send a batch every 2 seconds, and the worker also forwards the Nginx access log), or the CloudWatch agent collects the files (the optional step). Lambda logs always arrive automatically.
:::

## Comparison experiments

### The same queries, side by side (logging/query-compare, required)

- **Without (local files)**: first the shared fault injection API makes about 20% of requests return 503, then you run "count 5xx by route" and "find by request ID". All you can do is scan the current file and `.1`
  backwards on the instance, covering only this machine's last two days.
- **With CloudWatch Logs**: the same two queries gain a second side: FilterLogEvents finds exact matches, and Logs Insights aggregates and reports **bytes scanned** (what it bills by).
- **Where you see it**: the 5xx counts, durations and bytes scanned on both sides in the comparison report; both counts should match the number of 503s the client saw.

### Ingestion latency (logging/ingest-lag, required)

- **With CloudWatch Logs**: how long it takes from 20 requests completing until they can be found in CloudWatch. The server-side evidence is each log event's `ingestionTime − timestamp`;
  local files are visible immediately.

## Platform mode notes

The comparison experiments run on the workbench, and the queries run through the app's `GET /api/lab/logs` (admins only) with the instance role: your learner identity is only used to look at Logs Insights in the console.
`/atl-recordings/terminal-sessions` is the platform's optional terminal recording log group; it does not belong to CloudAlbum and this card does not use it.
