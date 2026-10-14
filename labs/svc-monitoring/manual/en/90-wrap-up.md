---
section: wrap-up
---

## What you did

- Moved alarms from "an evaluator inside the instance" to the AWS side: when the services or the instance stop, the heartbeat alarm still fires and is delivered through SNS.
- Saw CloudWatch's trade-offs: alarms take minutes, and custom metrics and alarms are billed by usage.
- Used the agent to fill in the memory and disk metrics that EC2 does not have by default.

## Exam points recap

- Basic vs detailed monitoring; EC2 has no memory or disk utilization and needs the CloudWatch agent; system and instance status checks.
- The three alarm states, periods and M of N, `TreatMissingData`, metric math, composite alarms (notification only).
- Alarm actions: SNS, EC2 stop / terminate / reboot / recover, and Auto Scaling policies.
- Custom metric dimensions and cardinality; PutMetricData and EMF; statistic sets cannot give percentiles.
- The difference between CloudWatch (performance), CloudTrail (API auditing) and AWS Config (configuration compliance).
