---
section: overview
---

## 背景

L0 的日志只在 EBS 数据卷上：api 与 worker 用 pino 写 JSON 行到 `/var/lib/cloudalbum/logs/api.log`、`worker.log`，Nginx 写
`nginx-access.json`。要查问题只能登录这台实例逐个文件 grep；多实例时每台各看各的，实例一被替换日志就跟着消失，Lambda 的日志根本不在本地。
这张卡片让应用把**同一份**结构化日志批量送进 Amazon CloudWatch Logs，本地文件照写，所以回滚没有数据缺口。

:::why
EC2 上写到文件里的日志不会自动进入 CloudWatch Logs：要么应用自己调用 `PutLogEvents`（本模块默认的 sdk 方式，api 与 worker
每 2 秒批量发送一次，worker 另外转发 Nginx 访问日志），要么由 CloudWatch Agent 采集文件（选做步骤）。Lambda 的日志则总是自动进入。
:::

## 对比实验预告

### 同一查询，两侧并排（logging/query-compare，必做）

- **没有（本地文件）**：先用共享故障注入接口让约 20% 的请求返回 503，再“按路由统计 5xx”和“按请求 ID 查找”。只能在实例上倒序扫描
  当前文件与 `.1`，只覆盖本机最近两天。
- **有了 CloudWatch Logs**：同样的两条查询再加一侧：FilterLogEvents 精确查找，Logs Insights 聚合并报告**扫描字节**（计费依据）。
- **你会在哪里看到**：对比报告中两侧的 5xx 条数、用时与扫描字节；两侧的条数应当与客户端看到的 503 个数一致。

### 摄取延迟（logging/ingest-lag，必做）

- **有了 CloudWatch Logs**：20 个请求从完成到能在 CloudWatch 查到要多久。服务端证据是每条日志的 `ingestionTime − timestamp`；
  本地文件则是立即可见。

## 平台模式说明

对比实验在工作台运行，查询经应用的 `GET /api/lab/logs`（仅管理员）以实例角色执行：你的学员身份只用来在控制台查看 Logs Insights。
`/atl-recordings/terminal-sessions` 是平台终端的可选录制日志组，不属于 CloudAlbum，本卡不使用。
