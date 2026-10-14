---
section: overview
---

## Background

At L0, alarms are decided by the **local alarm evaluator** inside the worker process: every 30 seconds it reads the per-minute aggregates and host samples that LabMetricsStore writes to the database,
decides OK / ALARM by the rules in `/etc/cloudalbum/alerts.yaml` (5xx rate, p95, memory, data disk, api heartbeat), and on a state change writes an in-app message to admins and
sends an email through EmailPort. The problem: the evaluator runs on the same machine as the app it watches — if the worker dies nobody evaluates, and if the instance dies nobody raises an alarm;
EC2 also has no memory metric by default.

This card also batch-sends the same metrics to Amazon CloudWatch (`cloudwatch = local + batch upload`, and the local side keeps working),
the CloudWatch agent fills in memory and disk, and alarms are evaluated on the AWS side and emailed through the module's own SNS topic `ops-alarms`.

:::why
An alarm system must be **decoupled** from what it monitors: the heartbeat metric has one point per minute, and the alarm treats "no data" as breaching (`TreatMissingData=breaching`),
so when the process dies or the instance stops and data goes missing, the alarm still goes to ALARM. The local evaluator cannot do this — it lives on that same machine.
:::

## Comparison experiments

### Time to alert (monitoring/time-to-alert, required)

- **Without CloudWatch**: the local evaluator runs every 30 seconds and reaches ALARM within seconds to tens of seconds; delivery is through in-app messages and the outbox.
- **With CloudWatch**: for the same 5xx, a CloudWatch alarm needs 1-minute periods × 3 of 5 data points, plus the 60-second batch upload and the delay before metrics appear — minutes.
- **Where you see it**: `biz.local_detect_sec` and `biz.cw_detect_sec` in the report — both are state-change times recorded on the server side (local `alert_events`,
  CloudWatch alarm history), not responses seen by the client.
- **If the results are not what you expect**: if the CloudWatch side never alarms, first check that monitoring is Healthy (are uploads lagging?), then whether the experiment ran long enough.

### Outage (monitoring/kill-test, required)

- **Without CloudWatch**: during the 5 minutes the api and worker are stopped, the local evaluator is completely silent — not a single alarm.
- **With CloudWatch**: the same service stop, and `app-heartbeat` goes to ALARM after three or four minutes, with the email delivered as usual.
- **Where you see it**: `biz.local_alerts_during_outage` (should be 0) and `biz.cw_heartbeat_alarm`; the ALARM email in your mailbox.

## Platform mode notes

The comparison experiments run on the workbench; the fault script that stops the services is sent to the lab instance through SSM Run Command (`--fault-via ssm`), so you do not need to sign in to the lab instance.
The optional "stop the instance" takes the platform management channel offline for a few minutes; the step declares an expected outage, so the UI shows "expected outage" rather than a failure.
