---
step: pitr
---

（选做）时间点恢复：把数据库恢复到 10 分钟前，结果是一个**新实例**。剩余时间不足 40 分钟时跳过本步骤。

先取出原实例的子网组与安全组（恢复时必须显式指定）：

```bash {runsOn=workstation}
SUBNET_GROUP=$(aws rds describe-db-instances --db-instance-identifier "{{ var.dbInstanceId }}" --query "DBInstances[0].DBSubnetGroup.DBSubnetGroupName" --output text)
DB_SG=$(aws rds describe-db-instances --db-instance-identifier "{{ var.dbInstanceId }}" --query "DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId" --output text)
```

发起恢复（单 AZ、不可公开访问，带上会话标签）：

```bash {runsOn=workstation}
aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier "{{ var.dbInstanceId }}" --target-db-instance-identifier cloudalbum-{{ session.env }}-pitr --restore-time "$(date -u -d '-10 min' +%Y-%m-%dT%H:%M:%SZ)" --db-instance-class db.t4g.micro --db-subnet-group-name "$SUBNET_GROUP" --vpc-security-group-ids "$DB_SG" --no-multi-az --no-publicly-accessible --tags Key=Project,Value=CloudAlbum Key=atl:component,Value=env Key=atl:session-id,Value={{ session.id }} Key=atl:lab-id,Value={{ session.labId }} Key=atl:env-id,Value={{ session.envId }}
```

:::wait{typical=15 max=40}
从自动备份与事务日志恢复出新实例。等本步骤的检查通过后再继续。
:::

检查通过后**立即删除**这个实例：

```bash {runsOn=workstation}
aws rds delete-db-instance --db-instance-identifier cloudalbum-{{ session.env }}-pitr --skip-final-snapshot --delete-automated-backups
```

:::expected
恢复出的实例有自己的新端点；原实例不受影响。删除后结束检查会确认它已不存在。
:::

::checks
