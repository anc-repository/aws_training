# monitoring 实验（本地评估器 vs CloudWatch 告警）

设计：[docs/modules/05-ops-observability.md#monitoring](../../docs/modules/05-ops-observability.md) 第 5、12 节。所有判定都取**服务端证据**：
本地告警评估器写入 `alert_events` 的状态变化、CloudWatch 告警自己的状态变化历史（`DescribeAlarmHistory`）、LabMetricsStore 与
CloudWatch 的曲线——都经应用的 `/api/lab/monitoring/*`（仅管理员）读取，运行器不在工作台上调用 AWS SDK。

| 标签 | 前置条件（capabilities） |
|---|---|
| `before` | `monitoring.driver=local`（LabMetricsStore + worker 内的本地评估器） |
| `after` | `monitoring.driver=cloudwatch`、`monitoring.status=ok/degraded` |
| `stop-instance` | 同 `after`；kill-test 的一次性变体（`role: single`），只接受 `--param phase=instance` |

服务端接口（`backend/src/adapters/monitoring/lab-routes.ts`）：

| 接口 | 内容 |
|---|---|
| `GET /api/lab/monitoring/alarms` | 本地规则（`alerts.yaml`，送达路径“本地”）与 CloudWatch 告警（送达路径 SNS）的当前状态、评估器心跳、上报状态 |
| `GET /api/lab/monitoring/history?name=&source=local\|cloudwatch\|both&since=` | 状态变化历史 |
| `GET /api/lab/monitoring/series?name=&stat=&period=&since=&source=&namespace=&instanceId=` | 曲线（本地：`route.*`、`host.*`；CloudWatch：`CloudAlbum/App`、`CWAgent`、`AWS/EC2`） |
| `GET /api/lab/monitoring/synthetic?rate=0.5` | 按概率返回 503 的合成负载（time-to-alert 的缺省故障源） |

## time-to-alert

```bash
npm run exp -- monitoring --label before --scenario time-to-alert --upload       # 切换前：只有本地一侧
scripts/module enable monitoring --param AlertEmail=you@example.com             # 并确认 SNS 订阅邮件
npm run exp -- monitoring --label after  --scenario time-to-alert --upload       # 切换后：本地与 CloudWatch 并排
npm run exp:report -- monitoring --experiment time-to-alert
```

以 `rps` 的速率请求 `/api/lab/monitoring/synthetic?rate=<rate>`，直到 `app-5xx-rate` 进入 ALARM（或 `maxWaitSec`）。
`biz.local_detect_sec`：本地评估器（30 秒一次，窗口 5 分钟）记录的 ALARM 时刻 − 负载开始；`biz.cw_detect_sec`：CloudWatch
（1 分钟 × 3 of 5，加上 60 秒批量上报与指标出现延迟）。SNS 邮件的到达时间在邮箱里记录。

`--param source=fault-api` 改用文档原写法 `POST /api/lab/faults {"type":"error5xx"}`：它作用于**全部**请求，包括
`healthcheck.sh` 每 30 秒一次的 `/api/health/live`，失败会让本机健康检查重启 api、故障随进程消失。集成阶段让 `/api/health/*`、
`/api/lab/*` 豁免之前，请用缺省的合成负载。

## kill-test

```bash
# 独立模式（缺省 phase=all：先停服务，再停实例）
npm run exp -- monitoring --label after --scenario kill-test --fault-via ssh --ssh ec2-user@<EIP>
# 平台模式与卡片：两侧都只做“停服务”，成对比较
npm run exp -- monitoring --label before --scenario kill-test --param phase=service --upload
npm run exp -- monitoring --label after  --scenario kill-test --param phase=service --upload
npm run exp -- monitoring --label stop-instance --scenario kill-test --param phase=instance --upload   # 选做
```

- `faults/stop-app.sh <phase> <downSec>`（实验机，root，经投递通道）：先用 `systemd-run --on-active` 安排恢复，再停 api 与 worker——
  投递通道断开或运行器超时都不影响服务按时启动。
- `faults/stop-instance.sh <phase> <downSec> <instanceDownSec> [<instanceId>]`（运维机 / 工作台，`via: local`，调用者凭证）：
  在后台停止实验机、保持 `instanceDownSec` 秒、启动并等 `PingStatus=Online`；只要停过实例，退出前一定把它启动回来。
  实例 ID 依次取参数、`EXP_INSTANCE_ID`、`.cloudalbum/state.json`，平台模式下按 `atl:env-id` + `atl:role=lab-app` 标签发现。
- 判定：`biz.local_alerts_during_outage`（宕机期间 `alert_events` 的状态变化条数，应为 0：评估器与 api 一起停了）、
  `biz.cw_heartbeat_alarm` / `biz.cw_detect_sec`（`app-heartbeat` 因 `TreatMissingData=breaching` 进入 ALARM 的时刻）。
- 平台模式：`stop-instance` 必须配 `phase=instance`，`before` / `after` 只接受 `phase=service`（06 PM-M30），不符合时场景报错。
  停实例会让管理通道暂时离线，卡片步骤声明了 `expectedOutage`。

## mem-visibility

```bash
npm run exp -- monitoring --label after --scenario mem-visibility --param mib=256 --upload
```

经共享故障注入占用内存（`{"type":"mem"}`，每次 64 MiB，需要 `featureFlags['lab.faults']=true`），保持 `holdSec` 秒后释放。
对比三条曲线：`AWS/EC2 MemoryUtilization`（不存在，`biz.ec2_mem_points=0`）、`CWAgent mem_used_percent`（Agent 上报）、
本地 `host.memUsedRatio`。keys 模式下 Agent 片段不投放，CWAgent 一侧为空。

## resolution

```bash
npm run exp -- monitoring --label after --scenario resolution --fault-via ssh --ssh ec2-user@<EIP> --upload
scripts/module enable monitoring --param AlertEmail=you@example.com --param DetailedMonitoring=true   # 详细监控按实例计费
npm run exp -- monitoring --label after --scenario resolution --fault-via ssh --ssh ec2-user@<EIP> --upload
```

第 30 秒 `faults/cpu-spike.sh` 占满一个核 `spikeSec` 秒（后台执行，超时自动结束）。比较本地 `host.loadavg1`（10 秒一个点）与
`AWS/EC2 CPUUtilization` 的 1 分钟、5 分钟两种周期：基础监控下 3 分钟尖峰可能被平均成小坡。做完记得把 `DetailedMonitoring` 改回 `false`。

## notify-path（手工）

需要部署者凭证（应用角色没有 `cloudwatch:SetAlarmState`）：

```bash
aws cloudwatch set-alarm-state --alarm-name cloudalbum-lab-app-5xx-rate --state-value ALARM --state-reason "lab test"
aws cloudwatch describe-alarm-history --alarm-name cloudalbum-lab-app-5xx-rate --history-item-type StateUpdate --max-records 3
```

确认邮箱收到 SNS 邮件（订阅必须已确认）；下一次评估告警会按真实数据回到 OK——`set-alarm-state` 只是临时改状态。
