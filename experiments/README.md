# experiments：对比实验框架

按总纲 [§8.2](../docs/modular-design.md) 实现的实验运行器（Node 22 + undici，不依赖 k6）。每个模块一个目录（目录名 = 模块 id），
实验 id 与 `modules/registry.yaml` 的 `lab.experiments` 一致；能自动化的写成 Node 场景，必须在控制台或云端操作的写成手工步骤（见各模块 README）。

```
experiments/
├── _lib/
│   ├── runner.ts          npm run exp：参数 → 前置断言 → 登记运行 → 预热 → 场景 + 故障 → 拉取服务端指标 → 清理 → 写结果
│   ├── collect.ts         /api/capabilities 快照与 requires 断言、/api/lab/runs、/api/lab/metrics → 结果的 server 段
│   ├── report.ts          npm run exp:report：before / after（或 A / B）对比 → Markdown + JSON（+ HTML）
│   ├── login.ts           npm run exp:login：以实验管理员登录并缓存令牌
│   ├── http.ts            undici 客户端：实验头、A/B 旁路交替与限流、解析 Server-Timing / X-CloudAlbum-Path
│   ├── stats.ts           客户端采集（路由 / 变体 / 目标 / 阶段 / 轮次）
│   ├── load.ts            闭环 VU 与开环固定速率负载
│   ├── metrics.ts         指标键（client.* / server.* / host.* / biz.* / scenario.*）→ 数值
│   ├── faults.ts          故障注入（api / ssh / ssm / local / 手工提示）
│   ├── app.ts images.ts probe.ts session.ts scenario.ts schema.ts types.ts util.ts
│   ├── scenarios/         共用场景：upload-burst（storage / queue / image-processing）、feed-read（cache / database）
│   ├── leak-scan.sh       明文 AWS 密钥泄露面扫描（iam/leak-scan）
│   └── schema/            experiment.schema.json、result.schema.json
├── <module>/              experiment.json + <scenario>.ts + faults/*.sh + README.md
├── _results/<module>/<UTC>__<label>__<runId>.json     （.gitignore）
└── _reports/<module>/<UTC>__<实验>.md|json|html        （.gitignore）
```

## 准备

```bash
npm run build                                   # 运行器经 node_modules 解析 @cloudalbum/contracts 的 dist
export EXP_TARGET=http://<EIP>                  # 缺省取 .cloudalbum/state.json 的 APP_BASE_URL，再缺省 http://localhost:3000
export CLOUDALBUM_ADMIN_EMAIL=… CLOUDALBUM_ADMIN_PASSWORD=…
npm run exp:login -w @cloudalbum/experiments    # 令牌缓存在 .cloudalbum/experiments/admin-token.json（0600）
# 或直接 export CLOUDALBUM_ADMIN_TOKEN=<管理员 access token>
```

负载机最好是同区域的另一台 EC2；切换前后两次测量的客户端与参数必须一致。

## 运行

```bash
cd experiments
npm run exp -- <module> --list                                       # 列出实验、对比方式与可用标签
npm run exp -- queue --label before --scenario upload-burst           # 切换前
scripts/module enable queue                                           # （仓库根目录）
npm run exp -- queue --label after  --scenario upload-burst --upload  # 切换后，并上传到 /lab 历史
npm run exp:report -- queue                                           # 最新的 before 对 after
npm run exp -- cache --label after --scenario feed-read --ab          # 运行时 A/B
npm run exp:report -- cache --experiment feed-read --pair after:A,after:B
```

| 选项 | 说明 |
|---|---|
| `--label` | 必须是 `experiment.json` 中 `requires` 的键（`^[a-z][a-z0-9-]{0,23}$`）。运行前按 `requires[label]` 校验管理员视图的 capabilities，不匹配拒绝运行（退出码 3） |
| `--force` | 不满足前置条件也运行；结果记 `forced: true`，报告显著标注 `[FORCED]` |
| `--ab` | 实验声明了 `ab.bypass` 时，参与 A/B 的请求交替带 `X-Compare-Bypass`：**A = 带旁路头（相当于“没有”），B = 不带（“有”）**，标签 `<label>:A` / `<label>:B`。服务端限额（每管理员每分钟 120 个、每实例 4 个在途）在客户端主动限流 |
| `--vus 10,50,200` | 依次按阶段运行，结果的 `client.byStage` 分开统计 |
| `--repeat N` | 重复 N 轮；报告取各轮中位数并给出最小～最大区间（噪声带） |
| `--param k=v` | 实验声明的参数（类型 / 范围在 `experiment.json` 的 `params`） |
| `--fault-via` | 故障脚本的投递方式：`ssh`（`--ssh ec2-user@<EIP>`）、`ssm`（`--instance-id`，用部署者凭证调用 AWS CLI）、`local`（运行器就在实例上，或脚本本身调 AWS CLI）、`skip`。缺省按环境推断，Windows 上为 `skip` |
| `--upload` | 同时 `POST /api/lab/results` |
| `--keep` | 不清理实验中创建的照片 / 相册 |

退出码：0 成功；1 场景出错（结果仍写出）；2 用法或清单错误；3 前置条件不满足；4 目标不可达或没有管理员令牌。

## 结果与报告

结果 JSON 符合 `_lib/schema/result.schema.json`（总纲 §8.2 的字段 + `variant`、`requiresCheck`、`spec`、`scenario.findings`、`repeats`、`warnings`）：

- `client`：按 `METHOD 路由模板` 的延迟分布（p50 / p95 / p99 / max / 首字节）、状态码、Server-Timing 各模块耗时与每请求调用次数（desc 的 `xN`）、
  路径签名（`X-CloudAlbum-Path` 去掉 inst / az）与各模块段结果分布；`byVariant` / `byTarget` / `byStage` 分组。
- `server`：`/api/lab/metrics?run=<runId>` 的路由与路径签名分位数、端口耗时（按驱动）、主机采样（CPU、事件循环延迟、网卡字节差、RSS）、源站卸载；
  `business` 为场景计算的业务指标（缩略图就绪时间、jobsLost、排空时间……）。
- 预热请求不带实验头、不计入结果。登录等不带管理员令牌的请求也不带实验头（服务端只对管理员接受 `X-Experiment-*`），只出现在客户端统计里。

指标键（`metrics` / `expect` 与报告共用，详见 `_lib/metrics.ts`）：`client.http_req_duration{route:/api/feed}.p95`、`client.timing.database.calls_per_request`、
`client.outcome_ratio.cache.hit`、`server.route./api/photos/complete.p95`、`server.port.queue.dur.p95`、`host.cpu.p95`、`host.net_rx_bytes`、`biz.jobs_lost`、`scenario.<发现>`。

报告按 `expect` 逐条给出“符合 / 不符合 / 差异小于噪声带，无法判断 / 缺少数据”。噪声带 = max(`--noise`（默认 10%）× 两者较大值, 多轮区间的一半, 毫秒类指标 1 ms)。
报告只做方向性判断，不预设具体数值。

## 测试

```bash
npx vitest run --project experiments        # 对本地 mock 服务器（test/mock-server.ts）运行全部 Node 场景、运行器、采集与报告
npm run typecheck -w @cloudalbum/experiments
```
