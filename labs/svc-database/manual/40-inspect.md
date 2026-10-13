---
step: inspect
---

看懂网络、加密与备份。这些配置由模块栈管理，**只看不改**。

:::method{kind=console default}
::console-link[打开数据库实例]{link=rds.database dbId="{{ var.dbInstanceId }}"}

1. “连接和安全性”：主库与备库分别在哪个可用区；“公开访问”为否；VPC 安全组 `sg-db` 的 5432 入站来源是实验机安全组。
2. “配置”：存储已加密（`aws/rds` 默认密钥）；参数组中 `rds.force_ssl=1`。
3. “维护和备份”：自动备份保留 7 天；“最近的还原时间”通常落后当前时间几分钟。
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws rds describe-db-instances --db-instance-identifier "{{ var.dbInstanceId }}" --query "DBInstances[0].{AZ:AvailabilityZone,StandbyAZ:SecondaryAvailabilityZone,Backup:BackupRetentionPeriod,Restorable:LatestRestorableTime,SG:VpcSecurityGroups[0].VpcSecurityGroupId}"
```
:::

再从两个地方连接数据库端点。在**实验机终端**用 TLS 握手并校验 RDS CA（`openssl` 支持 PostgreSQL 的 STARTTLS）：

```bash {runsOn=lab}
openssl s_client -starttls postgres -connect "{{ var.dbHost }}:5432" -CAfile /etc/cloudalbum/rds-ca.pem -verify_return_error </dev/null 2>/dev/null | grep -E "Verify return code"
```

在**工作台终端**只测 TCP 连接能否建立：

```bash {runsOn=workstation}
timeout 5 bash -c 'exec 3<>/dev/tcp/{{ var.dbHost }}/5432' && echo open || echo blocked
```

:::expected
实验机输出 `Verify return code: 0 (ok)`；工作台输出 `blocked`。工作台与实验机同在默认 VPC，挡住它的是 `sg-db`；
`PubliclyAccessible=false` 则让端点只解析到私有地址。
:::

:::saa{domain=resilient confusable="Multi-AZ 实例部署 vs 只读副本"}
Multi-AZ 实例部署的备库同步复制、不可读，只用于故障转移；只读副本异步复制、可读、可跨区域。
Multi-AZ 集群部署有两个可读备库，是另一种部署形态。
:::

::checks
