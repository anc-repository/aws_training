---
step: failover
---

Failover: the runner keeps writing and runs `aws rds reboot-db-instance --force-failover` at second 30 (the fault script runs on the workbench as you and needs the instance ID).

```bash {runsOn=workstation}
export DB_INSTANCE_ID={{ var.dbInstanceId }}
npm run exp -- database --label after --scenario failover --upload
```

::experiment{module=database id=failover label=after}

:::wait{typical=3 max=10}
During the failover the instance status is rebooting; afterwards the old standby is the primary, and the endpoint's DNS points at the new primary.
:::

:::expected
The report shows a window of failed writes, after which the app reconnects automatically; the top of the page briefly shows "数据库重连中" (reconnecting to the database). The primary has moved to the standby AZ you recorded in step 4.
:::

:::tip
After a failover, the primary and the lab instance may be in different AZs, so single-query latency goes up a little — that is a cross-AZ network round trip, not a fault.
:::

::checks
