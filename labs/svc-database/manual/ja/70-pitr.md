---
step: pitr
---

（任意）ポイントインタイムリカバリです。データベースを 10 分前の状態に復元すると、結果は**新しいインスタンス**になります。残り時間が 40 分未満ならこのステップはスキップしてください。

まず元のインスタンスのサブネットグループとセキュリティグループを取得します（復元時に明示的な指定が必要です）。

```bash {runsOn=workstation}
SUBNET_GROUP=$(aws rds describe-db-instances --db-instance-identifier "{{ var.dbInstanceId }}" --query "DBInstances[0].DBSubnetGroup.DBSubnetGroupName" --output text)
DB_SG=$(aws rds describe-db-instances --db-instance-identifier "{{ var.dbInstanceId }}" --query "DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId" --output text)
```

復元を開始します（シングル AZ、パブリックアクセス不可、セッションのタグ付き）。

```bash {runsOn=workstation}
aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier "{{ var.dbInstanceId }}" --target-db-instance-identifier cloudalbum-{{ session.env }}-pitr --restore-time "$(date -u -d '-10 min' +%Y-%m-%dT%H:%M:%SZ)" --db-instance-class db.t4g.micro --db-subnet-group-name "$SUBNET_GROUP" --vpc-security-group-ids "$DB_SG" --no-multi-az --no-publicly-accessible --tags Key=Project,Value=CloudAlbum Key=atl:component,Value=env Key=atl:session-id,Value={{ session.id }} Key=atl:lab-id,Value={{ session.labId }} Key=atl:env-id,Value={{ session.envId }}
```

:::wait{typical=15 max=40}
自動バックアップとトランザクションログから新しいインスタンスを復元しています。このステップのチェックが合格してから先に進んでください。
:::

チェックが合格したら、このインスタンスを**すぐに削除**します。

```bash {runsOn=workstation}
aws rds delete-db-instance --db-instance-identifier cloudalbum-{{ session.env }}-pitr --skip-final-snapshot --delete-automated-backups
```

:::expected
復元したインスタンスには独自の新しいエンドポイントがあり、元のインスタンスには影響しません。削除後、終了時のチェックでもう存在しないことを確認します。
:::

::checks
