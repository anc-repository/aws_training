---
step: inspect
---

ネットワーク、暗号化、バックアップの設定を読み解きます。これらはモジュールスタックが管理しているので、**見るだけで変更しないでください**。

:::method{kind=console default}
::console-link[データベースインスタンスを開く]{link=rds.database dbId="{{ var.dbInstanceId }}"}

1. 「接続とセキュリティ」：プライマリとスタンバイがそれぞれどのアベイラビリティーゾーンにあるか。「パブリックアクセス可能」が「いいえ」であること。VPC セキュリティグループ `sg-db` の 5432 インバウンドのソースがラボ用インスタンスのセキュリティグループであること。
2. 「設定」：ストレージが暗号化されている（`aws/rds` のデフォルトキー）こと。パラメータグループで `rds.force_ssl=1` になっていること。
3. 「メンテナンスとバックアップ」：自動バックアップを 7 日間保持していること。「最新の復元時間」は通常、現在時刻より数分遅れています。
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws rds describe-db-instances --db-instance-identifier "{{ var.dbInstanceId }}" --query "DBInstances[0].{AZ:AvailabilityZone,StandbyAZ:SecondaryAvailabilityZone,Backup:BackupRetentionPeriod,Restorable:LatestRestorableTime,SG:VpcSecurityGroups[0].VpcSecurityGroupId}"
```
:::

次に 2 か所からデータベースのエンドポイントに接続します。**ラボ用インスタンスのターミナル**では、TLS ハンドシェイクを行い RDS の CA で検証します（`openssl` は PostgreSQL の STARTTLS に対応しています）。

```bash {runsOn=lab}
openssl s_client -starttls postgres -connect "{{ var.dbHost }}:5432" -CAfile /etc/cloudalbum/rds-ca.pem -verify_return_error </dev/null 2>/dev/null | grep -E "Verify return code"
```

**ワークベンチのターミナル**では、TCP 接続が確立できるかだけをテストします。

```bash {runsOn=workstation}
timeout 5 bash -c 'exec 3<>/dev/tcp/{{ var.dbHost }}/5432' && echo open || echo blocked
```

:::expected
ラボ用インスタンスでは `Verify return code: 0 (ok)` と表示され、ワークベンチでは `blocked` と表示されます。ワークベンチとラボ用インスタンスはどちらもデフォルト VPC にあり、ワークベンチを止めているのは `sg-db` です。
`PubliclyAccessible=false` により、エンドポイントはプライベートアドレスにしか解決されません。
:::

:::saa{domain=resilient confusable="Multi-AZ 实例部署 vs 只读副本"}
マルチ AZ のインスタンスデプロイのスタンバイは同期レプリケーションで読み取り不可、フェイルオーバー専用です。リードレプリカは非同期レプリケーションで読み取り可能、クロスリージョンにもできます。
マルチ AZ の DB クラスターデプロイには読み取り可能なスタンバイが 2 つあり、これは別のデプロイ形態です。
:::

::checks
