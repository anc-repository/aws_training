# experiments/logging：本地文件 vs CloudWatch Logs

对应 [05-ops-observability.md#logging](../../docs/modules/05-ops-observability.md#logging) 第 5 节。服务端证据都经应用的
`GET /api/lab/logs`（仅管理员，`backend/src/adapters/logging/lab-routes.ts`）取得：`store=local` 是实例上倒序扫描
`/var/lib/cloudalbum/logs/` 的结果（用时、扫描字节），`store=cloudwatch` 是 FilterLogEvents（行带 `eventTs` 与 `ingestedAt`）
或 Logs Insights（`queryId` → 结果与 `statistics.bytesScanned`）。工作台不需要 `logs:*` 权限：查询由实例角色执行。

| 实验 | 标签 | 运行 | 服务端证据 |
|---|---|---|---|
| `ingest-lag` | after | `npm run exp -- logging --label after --scenario ingest-lag --upload` | 每条 Nginx 访问日志在 CloudWatch 中的 `ingestionTime − timestamp` |
| `query-compare` | before / after | `npm run exp -- logging --label before --scenario query-compare --upload`，切换后 `--label after` | 两侧的 5xx 计数、扫描字节与用时；与客户端看到的 503 个数互相印证 |
| `instance-loss` | after | `npm run exp -- logging --label after --scenario instance-loss --param requestId=<rid> --upload` | 同一个 requestId 在本地与 CloudWatch 中的行数与来源实例 |
| `overhead` | before / after | `npm run exp -- logging --label before --scenario overhead`，切换后 `--label after` | `/api/lab/metrics?run=` 的主机采样（api 的 CPU p95、事件循环延迟 p99） |
| `debug-volume` | 手工 | 见下文 | CloudWatch 指标 `AWS/Logs IncomingBytes` |

## 准备

- 目标是实例的 `http://<EIP>`（经过 Nginx：请求 ID 来自 Nginx 的 `$request_id`，访问日志的 `run` 字段是运行 ID）。
- `query-compare` 用共享故障注入接口制造 5xx，需要运行时热键 `featureFlags['lab.faults']=true`（svc-logging 的起始状态已打开）。
- 本地一侧只覆盖本机当前文件与 `.1`：超过两天的日志、其他实例与 Lambda 的日志都不在本地，这本身就是对比点。

## 查询对比的两条语句

- 按路由统计 5xx：本地 `store=local&source=nginx&level=error&q=<runId>`；CloudWatch
  `filter run = "<runId>" and status >= 500 | stats count(*) as errors by uri`（Logs Insights，按扫描量计费，以官方定价为准）。
- 按 requestId 查找：两侧都用 `requestId=<rid>`（应用日志的 `requestId` 与 Nginx 的 `rid` 是同一个值）。

控制台对照：CloudWatch → Logs Insights 中运行保存的查询 `cloudalbum-<env>/5xx-by-route`；命令行
`aws logs tail /cloudalbum/<env>/nginx --follow --format short`。

## 实例丢失（instance-loss）

1. 记下一个请求 ID：`curl -s -D - -o /dev/null http://<EIP>/api/health/ready | grep -i x-cloudalbum-request-id`。
2. 替换实例：启用 autoscaling 时 `aws autoscaling terminate-instance-in-auto-scaling-group --instance-id <id> --no-should-decrement-desired-capacity`；
   单实例时 `scripts/module rebuild-instance`（数据卷改挂到新实例，本地日志随卷迁移，所以单实例下看不出差别）。
3. `npm run exp -- logging --label after --scenario instance-loss --param requestId=<rid> --upload`。

## 发送器开销（overhead）

sdk 方式看 `--label before / after` 两次运行的 `host.cpu.p95` 与 `host.event_loop_delay.p99`。agent 方式的开销在 Agent 进程上：
`top -p $(pgrep -f amazon-cloudwatch-agent)`（内存在数十 MB 量级）。

## 费用感知（debug-volume，选做，手工）

1. `sudo bash /opt/cloudalbum/experiments/logging/faults/log-level.sh debug`（实验机上；平台模式经 SSM 执行同一脚本）。
2. 正常使用应用 10 分钟。
3. `sudo bash /opt/cloudalbum/experiments/logging/faults/log-level.sh info`。
4. CloudWatch 控制台 → 指标 → `AWS/Logs` → `IncomingBytes`（维度 `LogGroupName=/cloudalbum/<env>/app`），比较前后两个 10 分钟。
   本版应用在请求路径上写的 debug 日志很少，增幅可能不明显；Nginx 访问日志的量不受 `logLevel` 影响。
