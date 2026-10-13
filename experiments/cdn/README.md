# cdn 实验（有 / 无 CloudFront）

设计：[docs/modules/01-edge-network-scaling.md#cdn](../../docs/modules/01-edge-network-scaling.md) 第 5 节。对比方式是“按 URL 的 A/B”：
直连源站（`CDN_ORIGIN_DIRECT_URL` 或 `--target`）与经 CloudFront（`CDN_BASE_URL`）两条路径同时在线，脚本分别请求。
准备：`CDN_DIRECT_ACCESS=open`（或 `admin-ip` 且包含实验机 IP）；需要从单一 IP 压测时设置 `WAF_LAB_ALLOW_CIDR`。
两个基址缺省从 capabilities 读取，也可以 `--param direct=http://<EIP> --param cdn=https://dxxxx.cloudfront.net` 指定。

| 标签 | 前置条件 |
|---|---|
| `before` | `cdn.driver=direct` |
| `after` | `cdn.driver=cloudfront`、`cdn.status=ok/degraded` |

## ttfb

```bash
npm run exp -- cdn --label after --scenario ttfb --upload            # 在 us-east-1、eu-west-1、ap-southeast-2、ap-northeast-1 的 CloudShell 各跑一次
```

对两条路径各请求 `samples`（默认 20）次，**每次新建连接**，记录 DNS / TCP / TLS / 首字节 / 总耗时与 `X-Cache`、`X-Amz-Cf-Pop`、`Age`、
Server-Timing 的 `cdn-*` 项（`scenario.direct`、`scenario.cdn`、`cdnVsDirectTtfbRatio`）。被测资源缺省为首页引用的第一个 `/assets/*.js`
（`--param path=` 可改为某张缩略图）。Node 的 http 模块只说 HTTP/1.1：协议对比（h2 / h3、`Alt-Svc`）请在浏览器 `/lab` 上看。

## media-load

```bash
npm run exp -- cdn --label after --scenario media-load --duration 5m --param target=direct
npm run exp -- cdn --label after --scenario media-load --duration 5m --param target=cdn       # 两轮之间间隔 5 分钟
```

每次迭代加载相册 JSON + 30 张缩略图 + 1 张展示图；直连轮次请求 API 时带 `X-Compare-Bypass: cdn` 以拿到源站 URL。
观察 `/lab` 的“源站负载”面板、结果的 `server.origin`（按是否经 CloudFront 拆分的源站请求数）与 `host.net_tx_bytes`；可选 CloudWatch 的
EC2 `NetworkOut` 与 us-east-1 的 CloudFront `Requests`。

## origin-requests

```bash
npm run exp -- cdn --label after --scenario origin-requests --param windowMin=15
```

读取最近 `windowMin` 分钟的源站卸载采样（Nginx JSON 访问日志），汇总经 CloudFront / 经 ALB / 直连的请求数与字节数。

## api-nocache

```bash
npm run exp -- cdn --label after --scenario api-nocache
```

经 CDN 两次 `/api/lab/now`（private, no-store）：都应 Miss、时间戳不同；两次 `/api/public/now`（s-maxage=10）：第二次 Hit、时间戳相同。
再比较直连与经 CDN 访问 `/api/lab/now` 的首字节时间。两个 now 端点由 cdn 模块提供。

## compression

```bash
npm run exp -- cdn --label before --scenario compression
npm run exp -- cdn --label after  --scenario compression
```

主 JS、CSS 与一个 API JSON 带 `Accept-Encoding: gzip, deflate, br` 请求两条路径，记录 `Content-Encoding` 与传输字节（`scenario.totalBytes`）。

## invalidation（手工）

在 `/lab` 的 cdn 卡片上依次：“覆盖同名缩略图”（`POST /api/lab/cdn/overwrite-thumb`）→ 经 CDN 刷新仍是旧图（Hit，`Age` 递增），直连已是新图 →
“创建失效”（`invalidate(['/media/<key>'])`，页面轮询直到 Completed 并显示耗时）→ 刷新后先 Miss 再显示新图 →“版本化键”
（`POST /api/lab/cdn/version-thumb`）→ 立即看到新图，不消耗失效配额。技巧：URL 后加 `?lab=<nonce>` 只绕过浏览器缓存，边缘仍然命中。
