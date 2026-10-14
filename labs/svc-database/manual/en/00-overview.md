---
section: overview
---

## Background

At L0, users, albums and photo metadata live in a single SQLite file on EBS, read and written in the same process as Node. It is simple and fast, but it has three hard limits:
one writer at a time, with the synchronous driver blocking the event loop under heavy concurrent writes; when EC2 stops, the database stops too; and the backups sit on the same disk as the data.
This card moves the database to Multi-AZ Amazon RDS for PostgreSQL: the app's Knex repository code stays the same, and you get managed backups, point-in-time recovery and automatic failover.

:::why
**Moving to RDS does not make a single query faster**: every query gains a network round trip inside the VPC. What RDS gives you is operational properties — backups, patching, monitoring, failover —
and no longer fighting the app process for the same event loop.
:::

## Comparison experiments

### Mixed reads and writes (database/mixed-rw, required)

- **Without RDS (SQLite)**: at low concurrency, in-process queries are fastest; at 50 concurrent users writes queue up and the event loop delay P99 spikes.
- **With RDS**: at low concurrency a single request is slightly slower (one more network round trip); at high concurrency latency rises gently and the event loop is no longer blocked.
- **Where you will see it**: timeline p50 / p95 per concurrency stage (`client.byStage`), `host.event_loop_delay.p99` and the error rate in the comparison report;
  the database segment of the `X-CloudAlbum-Path` response header changes from `sqlite` to `postgres@rds`.

### Failure and recovery (database/failover, required)

- **SQLite**: the runner restarts api at second 30, and writes stop until the process is back.
- **RDS Multi-AZ**: the runner forces a failover at second 30, and the app reconnects automatically after a short period of failed writes (see the official docs and your own measurements for the duration).

## Platform mode notes

The Multi-AZ primary and standby are both billed by instance hours, so you can end the lab early once the required steps are done. The comparison experiments run on the workbench;
the runner triggers the failover by running `aws rds reboot-db-instance --force-failover` on the workbench as you.
