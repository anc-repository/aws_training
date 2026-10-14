---
step: pitr
---

(Optional) Point-in-time recovery: restore the database to 10 minutes ago — the result is a **new instance**. Skip this step if less than 40 minutes remain.

First fetch the original instance's subnet group and security group (they must be specified explicitly when restoring):

```bash {runsOn=workstation}
SUBNET_GROUP=$(aws rds describe-db-instances --db-instance-identifier "{{ var.dbInstanceId }}" --query "DBInstances[0].DBSubnetGroup.DBSubnetGroupName" --output text)
DB_SG=$(aws rds describe-db-instances --db-instance-identifier "{{ var.dbInstanceId }}" --query "DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId" --output text)
```

Start the restore (single-AZ, not publicly accessible, with the session tags):

```bash {runsOn=workstation}
aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier "{{ var.dbInstanceId }}" --target-db-instance-identifier cloudalbum-{{ session.env }}-pitr --restore-time "$(date -u -d '-10 min' +%Y-%m-%dT%H:%M:%SZ)" --db-instance-class db.t4g.micro --db-subnet-group-name "$SUBNET_GROUP" --vpc-security-group-ids "$DB_SG" --no-multi-az --no-publicly-accessible --tags Key=Project,Value=CloudAlbum Key=atl:component,Value=env Key=atl:session-id,Value={{ session.id }} Key=atl:lab-id,Value={{ session.labId }} Key=atl:env-id,Value={{ session.envId }}
```

:::wait{typical=15 max=40}
Restoring a new instance from automated backups and transaction logs. Wait until this step's check passes before you continue.
:::

Once the check passes, **delete** the instance right away:

```bash {runsOn=workstation}
aws rds delete-db-instance --db-instance-identifier cloudalbum-{{ session.env }}-pitr --skip-final-snapshot --delete-automated-backups
```

:::expected
The restored instance has its own new endpoint, and the original instance is not affected. After you delete it, the end-of-lab check confirms that it is gone.
:::

::checks
