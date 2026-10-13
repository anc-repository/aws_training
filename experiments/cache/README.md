# cache 实验（有 / 无 ElastiCache）

设计：[docs/modules/03-data-storage.md#cache](../../docs/modules/03-data-storage.md) 第 5 节。先 `node dist/cli.js lab:seed --users 200 --albums-per-user 5 --photos 20000` 准备数据。

| 标签 | 前置条件（capabilities） |
|---|---|
| `before` | `cache.driver=none` |
| `memory` | `cache.driver=memory`（本地档） |
| `selfhost` | `cache.driver=redis`、`cache.status=off`（EC2 自建 Valkey，本地档） |
| `after` | `cache.driver=redis`、`cache.status=ok/degraded`（ElastiCache） |

## feed-read

```bash
npm run exp -- cache --label after --scenario feed-read --ab --vus 20 --duration 120s     # 运行时 A/B
npm run exp:report -- cache --experiment feed-read --pair after:A,after:B
npm run exp -- cache --label before --scenario feed-read      # 四档各一次（memory / selfhost / after 同理）
npm run exp:report -- cache --experiment feed-read --pair before,after
```

观察：A（`X-Compare-Bypass: cache`）与 B 的 `GET /api/feed` p95；每请求 DB 调用次数（`client.timing.database.calls_per_request`，命中时为 0）；
命中率（`scenario.cacheHitRatio`，排除 bypass）。单实例下 memory 命中比 redis 快（少一次网络往返）。

## cache-stampede

```bash
npm run exp -- cache --label after --scenario cache-stampede --param burst=100
```

每轮新建一个相册让相册列表键失效，再同时发出 `burst` 个 `GET /api/albums`。`scenario.dbCallsPerBurst`：none 档约等于 burst，
有缓存时每进程（每实例）只回源一次。结束后删除新建的相册。

## stale-read

需要两个进程：`LB_LOCAL_WORKERS=2`（预设 l0-plus-local-tiers）或 ASG 两台实例。

```bash
npm run exp -- cache --label memory --scenario stale-read --param ttlSec=60
npm run exp -- cache --label after  --scenario stale-read --param ttlSec=60
npm run exp:report -- cache --experiment stale-read            # 缺省 pair = memory,after
```

`ttlSec` 填运行时配置 `feedCacheTtlSec` 的当前值。观察 `scenario.staleRatio`（memory 约一半）、`longestStaleMs`（约等于 TTL）与 `byWorker`。

## fail-open

```bash
npm run exp -- cache --label selfhost --scenario fail-open --fault-via ssh --ssh ec2-user@<EIP>
CACHE_SG_ID=sg-… APP_SG_ID=sg-… npm run exp -- cache --label after --scenario fail-open     # revoke-sg.sh 在运维机执行
```

第 30 秒停掉 Valkey（或撤销 `sg-cache` 入站规则），第 80 秒恢复。预期 `client.errors=0`、路径头出现 `cache=redis@…:error-bypass`，
`/lab` 上 cache 状态变为 degraded 后回到 ok。

## ttl-sweep（手工）

1. `npm run exp -- cache --label after --scenario feed-read --duration 120s` 先跑一轮，记下命中率。
2. 在 `/admin` 的运行时配置（或 `runtime.json` / SSM 参数）把 `feedCacheTtlSec` 依次改为 10、60、300（热更新，不重启），每档重复第 1 步。
3. 用 `npm run exp:report -- cache --experiment feed-read --before <10 秒那轮的文件> --after <300 秒那轮的文件>` 对比；也可以对照 ElastiCache 的 `CacheHitRate`。
