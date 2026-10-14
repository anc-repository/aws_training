---
step: replica
---

(Optional) Read replica: add an asynchronously replicated replica to the module and send the app's read queries to the replica endpoint. The replica is a third hourly-billed instance and takes well over ten minutes to create.

```bash {runsOn=workstation}
scripts/module enable database --param MultiAz=true --param CreateReadReplica=true
```

Once the replica is available, compare reading from the primary with reading from the replica in a per-request A/B:

```bash {runsOn=workstation}
npm run exp -- database --label after --scenario replica-read --ab --upload
```

::experiment{module=database id=replica-read label=after}

:::expected
For the group that reads from the replica, the database segment of the path header points at the replica, and the read load on the primary goes down. Reading the replica right after a write may return stale data (asynchronous replication lag).
:::

::checks
