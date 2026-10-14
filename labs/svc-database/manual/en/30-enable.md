---
step: enable
---

Wire in RDS: the module creates a DB subnet group in the default VPC, `sg-db` (5432 only allows the lab instance's security group), a parameter group (`rds.force_ssl=1`, slow query log)
and a Multi-AZ `db.t4g.micro` instance (PostgreSQL 16, gp3 20 GiB, encrypted, automated backups kept for 7 days). It then downloads the RDS CA bundle to the lab instance,
migrates the SQLite data during a read-only window (with the worker stopped), and finally restarts.

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable database --param MultiAz=true --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable database --param MultiAz=true
```
:::

:::wait{typical=20 max=45}
Creating a Multi-AZ instance usually takes about 20 minutes (the primary and a standby in another AZ are created together). During the migration you can browse the app but not write.
:::

:::expected
database is Healthy and detail shows Multi-AZ and the primary's AZ; the path header contains `database=postgres@rds`; the admin page shows "PostgreSQL（Amazon RDS）".
:::

:::warning
Do not turn on deletion protection for the instance in the console: it makes the platform's reclaim fail, and the session goes to CLEANUP_FAILED.
:::

::checks
