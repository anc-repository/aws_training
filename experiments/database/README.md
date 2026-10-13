# database 实验（SQLite / 自建 PostgreSQL / RDS）

设计：[docs/modules/03-data-storage.md#database](../../docs/modules/03-data-storage.md) 第 5 节。先准备数据：
`node dist/cli.js lab:seed --users 200 --albums-per-user 5 --photos 20000`。

| 标签 | 前置条件 |
|---|---|
| `before` | `database.driver=sqlite` |
| `selfhost` | `database.driver=postgres`、`database.status=off`（EC2 自建 PG，本地档） |
| `after` | `database.driver=postgres`、`database.status=ok/degraded`（RDS） |

## mixed-rw

```bash
npm run exp -- database --label before   --scenario mixed-rw --vus 10,50,200
npm run exp -- database --label selfhost --scenario mixed-rw --vus 10,50,200
npm run exp -- database --label after    --scenario mixed-rw --vus 10,50,200
npm run exp:report -- database --experiment mixed-rw --pair before,after
```

`writeRatio`（默认 0.3）的请求是写：其中 `commentShare` 发评论（社交写接口按用户限速，429 单独计数），其余建私有相册（结束后删除）；
其余读时间线。三个并发阶段分别统计在 `client.byStage`。观察：时间线 p50 / p95（低并发与高并发）、`host.event_loop_delay.p99`
（SQLite 同步驱动阻塞事件循环）、Server-Timing 的 database 耗时与次数、错误率。不要指望“换成 RDS 就变快”：每次查询多一次网络往返。

## failover

```bash
DB_INSTANCE_ID=cloudalbum-<env>-db npm run exp -- database --label after --scenario failover --duration 180s
npm run exp -- database --label before --scenario failover --fault-via ssh --ssh ec2-user@<EIP>
```

每 200 ms 建一个相册、读回、删除；连续失败合并为失败区间（`scenario.windows`、`longestOutageMs`）。after：第 30 秒在运维机执行
`faults/rds-failover.sh`（`aws rds reboot-db-instance --force-failover`，要求 MultiAz=true，用部署者凭证）；before：第 30 秒重启 api 作为基线。
基线的“停止实例 → 启动实例”整站不可用时长请手工测量（在 failover 运行期间从控制台停止 / 启动实例）。

## replica-read

```bash
npm run exp -- database --label after --scenario replica-read --ab
npm run exp:report -- database --experiment replica-read --pair after:A,after:B
```

需要 `CreateReadReplica=true`。A 带 `X-Compare-Bypass: replica`（走主库），B 走副本（路径头 `database=postgres@rds:replica`）。主库 CPU 看 CloudWatch。

## replica-lag

```bash
npm run exp -- database --label after --scenario replica-lag
```

反复调用 `POST /api/lab/db/read-after-write`（主库写后立即从副本读）：`scenario.notVisibleRatio` 与 `lagMsP95`。端点由 database 模块提供。

## conn-storm（手工）

逐步调大 `DB_POOL_MAX`，并用 load-balancer 本地档 `LB_LOCAL_WORKERS=2` 把 api 进程数加到 2，期间运行
`npm run exp -- database --label after --scenario mixed-rw --vus 200`，在 CloudWatch 看 `DatabaseConnections`，直到出现 `too many connections`。
启用 db-proxy 后用同样步骤对比。

## pitr（手工）

```bash
aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier <id> --target-db-instance-identifier <id>-pitr \
  --restore-time <10 分钟前的 UTC 时间> --db-subnet-group-name <同一子网组> --vpc-security-group-ids <sg-db>
node dist/cli.js db:verify --host <新实例端点>      # 比对行数
aws rds delete-db-instance --db-instance-identifier <id>-pitr --skip-final-snapshot
```

必须指定同一子网组与 `sg-db`，否则会用默认安全组。基线对照：只能恢复到最近一次本地 `.backup`。
