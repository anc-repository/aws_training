---
step: inspect
---

Read the network, encryption and backup settings. They are managed by the module stack, so **look but do not change**.

:::method{kind=console default}
::console-link[Open the DB instance]{link=rds.database dbId="{{ var.dbInstanceId }}"}

1. "Connectivity & security": which Availability Zone the primary and the standby are in; "Publicly accessible" is No; the 5432 inbound source of the VPC security group `sg-db` is the lab instance's security group.
2. "Configuration": storage is encrypted (the `aws/rds` default key); `rds.force_ssl=1` in the parameter group.
3. "Maintenance & backups": automated backups are kept for 7 days; "Latest restore time" is usually a few minutes behind the current time.
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws rds describe-db-instances --db-instance-identifier "{{ var.dbInstanceId }}" --query "DBInstances[0].{AZ:AvailabilityZone,StandbyAZ:SecondaryAvailabilityZone,Backup:BackupRetentionPeriod,Restorable:LatestRestorableTime,SG:VpcSecurityGroups[0].VpcSecurityGroupId}"
```
:::

Then connect to the database endpoint from two places. In the **lab instance terminal**, do a TLS handshake and verify it against the RDS CA (`openssl` supports PostgreSQL's STARTTLS):

```bash {runsOn=lab}
openssl s_client -starttls postgres -connect "{{ var.dbHost }}:5432" -CAfile /etc/cloudalbum/rds-ca.pem -verify_return_error </dev/null 2>/dev/null | grep -E "Verify return code"
```

In the **workbench terminal**, only test whether a TCP connection can be opened:

```bash {runsOn=workstation}
timeout 5 bash -c 'exec 3<>/dev/tcp/{{ var.dbHost }}/5432' && echo open || echo blocked
```

:::expected
The lab instance prints `Verify return code: 0 (ok)`; the workbench prints `blocked`. The workbench and the lab instance are both in the default VPC — what blocks the workbench is `sg-db`;
`PubliclyAccessible=false` makes the endpoint resolve only to a private address.
:::

:::saa{domain=resilient confusable="Multi-AZ 实例部署 vs 只读副本"}
The standby of a Multi-AZ instance deployment is replicated synchronously, cannot be read and is only for failover; a read replica is replicated asynchronously, can be read and can be in another Region.
A Multi-AZ DB cluster deployment has two readable standbys and is a different deployment option.
:::

::checks
