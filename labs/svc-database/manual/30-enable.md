---
step: enable
---

接入 RDS：模块在默认 VPC 中创建 DB 子网组、`sg-db`（5432 只放行实验机安全组）、参数组（`rds.force_ssl=1`、慢查询日志）
与 `db.t4g.micro` 的 Multi-AZ 实例（PostgreSQL 16、gp3 20 GiB、加密、保留 7 天自动备份），再把 RDS CA 包下载到实验机，
在只读窗口内（停 worker）把 SQLite 的数据迁移过去，最后重启。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable database --param MultiAz=true --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable database --param MultiAz=true
```
:::

:::wait{typical=20 max=45}
Multi-AZ 实例创建通常需要 20 分钟左右（同时创建主库与另一个 AZ 中的备库）。迁移期间应用可以浏览、不能写入。
:::

:::expected
database 的状态为“正常”，detail 显示 Multi-AZ 与主库所在 AZ；路径头出现 `database=postgres@rds`；管理后台显示“PostgreSQL（Amazon RDS）”。
:::

:::warning
不要在控制台给实例开启删除保护：它会让平台回收失败，会话进入 CLEANUP_FAILED。
:::

::checks
