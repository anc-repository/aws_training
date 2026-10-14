# waf 实验（Nginx limit_req vs AWS WAF）

设计：[docs/modules/01-edge-network-scaling.md#waf](../../docs/modules/01-edge-network-scaling.md) 第 5 节。

| 标签 | 前置条件 |
|---|---|
| `before` | `waf.driver=nginx`（L0：Nginx limit_req + 正则 + denylist） |
| `after` | `waf.driver=aws`、`waf.status=ok/degraded`（AWS WAF 挂在 CloudFront 上） |

**前提**（运行时 A/B，01 约定 13）：cdn 或 load-balancer 已启用；`CDN_DIRECT_ACCESS=admin-ip` 且包含实验机 IP，使直连与边缘两条路径都可达；
`WAF_LAB_ALLOW_CIDR` **必须为空**（否则实验机跳过全部 WAF 规则）。攻击脚本只针对自己账号里的资源，保持低速率并遵守 AWS 的渗透测试政策
（以官方文档为准），不做洪泛式压测。

被测入口缺省从管理员视图的 capabilities 读取：`direct`（`cdn.data.originDirectUrl`，EC2 的 Nginx）、`edge`（`cdn.public.baseUrl`，CloudFront）；
也可以 `--param direct=… --param edge=…` 指定。

**服务端证据（不看客户端响应头）**：攻击流量是匿名的，只带一个 `?atlprobe=<nonce>` 查询参数；管理员端点
`GET /api/lab/waf/origin?run=<runId>&nonce=<nonce>` 读源站 Nginx 访问日志，按 nonce 计数。被 AWS WAF 在边缘拦截的请求根本不会出现在源站
日志里（nonce 计数为 0 或只剩放行后回源到 8080 的那部分）；被 Nginx 的 `limit_req` 拦截的 429 仍然到达实例、仍被记录。托管规则组 Block 时返回
的是 CloudFront 的 403，不带应用的 `X-CloudAlbum-Path` 头——所以检查用服务端证据，不用客户端看到的响应头。

## flood（限速，短轮次）

```bash
npm run exp -- waf --label before --scenario flood --param target=direct    # 纯 Nginx
scripts/module enable waf                                                    # 仓库根目录（先 count 观察）
npm run exp -- waf --label after  --scenario flood --param target=edge --upload
npm run exp -- waf --label after  --scenario flood --param target=both --param rate=8 --param duration=30
```

从单个来源以固定速率 `rate`（默认 8 req/s，封顶 50）持续 `duration` 秒（默认 30，封顶 120）打 `POST /api/auth/login`（匿名、坏口令）。
逐秒记录状态码，计算到第一次被拦截的时间、拦截比例，并读 `/api/lab/waf/origin` 的 nonce 计数。Nginx 几乎立即以 429 拦截且每个请求都到达实例；
AWS WAF 的速率规则按窗口聚合、有检测延迟（数十秒），被拦截的请求不到达源站。

## payloads（攻击载荷识别）

```bash
npm run exp -- waf --label before --scenario payloads
npm run exp -- waf --label after  --scenario payloads --upload
```

发送一组公开的 WAF 测试载荷（SQL 注入的 URL / 二次编码 / 大小写注释变体、目录穿越、XSS、请求头里的 Log4Shell 探针字符串、扫描器 User-Agent），
生成“直连 Nginx vs 经 AWS WAF”的状态码对照表。`caughtOnlyByWaf` 列出 Nginx 漏掉而 AWS WAF 拦住的变体。只用于演示两者差别，不攻击任何第三方系统。

## false-positive（误杀）

```bash
npm run exp -- waf --label after --scenario false-positive               # WAF_RULE_ACTION=count
scripts/module enable waf --param RuleAction=block                        # 切到 block
npm run exp -- waf --label after --scenario false-positive               # 再跑一次对比
```

以管理员身份经 CloudFront 入口发两个合法但“可疑”的请求：一个 >8 KB 的大请求体（CRS 的 `SizeRestrictions_BODY` 已覆盖为 Count，应放行，否则
storage=local 的照片上传会被拦），一条含 `SELECT * FROM` 的正常文本（block 模式下可能被 SQLi 托管规则误杀）。在 WAF 的 Logs Insights 里
`stats count() by terminatingRuleId, action` 看是 COUNT 还是 BLOCK。

## bypass（源站锁定）

```bash
npm run exp -- waf --label before --scenario bypass    # 启用 WAF 前（源站未锁定）
npm run exp -- waf --label after  --scenario bypass    # 锁定源站后
```

不发攻击载荷，各发一个探测请求：`http://<EIP>/`（80）、`http://<EIP>:8080/`（不带密钥头）、8080 带错误密钥头。源站未锁定时 80 可直达
（可绕过 CloudFront 上的 WAF，DEP-018）；`CDN_DIRECT_ACCESS=admin-ip|closed` 收紧后 80 被拒 / 超时、8080 因 `X-Origin-Verify` 不匹配返回 403。

## 控制台与日志

- WAF → Web ACL → Overview 与 Sampled requests；
- Logs Insights（日志组在 Web ACL 所在区域——CLOUDFRONT 范围在 us-east-1）：`stats count() by terminatingRuleId, action`。

## 本模块不提供按请求绕过 WAF 的旁路

waf 刻意不在 registry `bypass` 中登记任何键：提供一个“跳过 WAF”的请求头本身就是安全漏洞。运行时 A/B 靠两条真实入口（直连 Nginx 与经 WAF 的
CloudFront），不靠旁路头。
