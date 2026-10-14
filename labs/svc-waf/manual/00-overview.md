---
section: overview
---

## 背景

L0 的“防火墙”是 EC2 上的 Nginx：`limit_req` 限速加几条正则，拦住明显的攻击，但**每个恶意请求都已经到达实例**，消耗连接、TLS、日志与带宽。
这张卡片把 **AWS WAF** 挂在 CloudFront 上，在边缘按托管规则与速率规则拦截——被拦截的请求根本到不了 EC2。前提是源站已经**锁定**，否则攻击者可以绕过。

:::why
WAF 工作在七层，只能关联 CloudFront、ALB、API Gateway REST API 等，不能关联 EC2 / EIP / NLB（DEP-006）。CLOUDFRONT 范围的
Web ACL、IP 集合、日志组都在 **us-east-1**，和东京的应用区域分开。
:::

:::warning
攻击脚本只针对你自己账号里的资源，保持低速率（短轮次），遵守 AWS 的渗透测试政策（以官方文档为准）。不要把 `flood` 提到洪泛级别。
:::

## 对比实验预告

### 限速（waf/flood，必做）

- **没有 AWS WAF（Nginx）**：从单个来源以略高于阈值的速率打直连入口，Nginx 的 `limit_req` 几乎立即以 429 拦截，但每个请求仍到达实例。
- **有了 AWS WAF**：同样的攻击打向 CloudFront，速率规则按窗口聚合、有检测延迟（数十秒），被拦截的请求不回源。
- **你会在哪里看到**：`/api/lab/waf/origin` 的 nonce 计数——直连每个请求都计入源站日志，经 WAF 拦截的请求不进源站日志。
- **如果结果不符合预期**：确认 `WAF_LAB_ALLOW_CIDR` 为空（否则实验机跳过全部规则）、源站已锁定且对工作台开放直连。

### 攻击载荷识别（waf/payloads，必做）

Nginx 的几条正则容易被二次编码 / 大小写 / 注释变体绕过；AWS 托管规则组识别更强。结果里的 `caughtOnlyByWaf` 列出 Nginx 漏掉而 WAF 拦住的变体。

### 源站锁定（waf/bypass，必做）

直接请求实验机的直连端口与 8080：未锁定时直连可达（可绕过 WAF，DEP-018）；锁定后直连被拒 / 超时、8080 因 `X-Origin-Verify` 不匹配返回 403。

### 误杀（waf/false-positive，必做）

合法但“可疑”的请求：大请求体（CRS 的 `SizeRestrictions_BODY` 已覆盖为 Count，应放行）、含 SQL 关键字的正常文本（Block 模式下可能被 SQLi 规则误杀）。

## 平台模式说明

`scripts/module enable waf` 在 us-east-1 创建 Web ACL，再把 `WebAclArn` 注入 cdn 栈（分配重新部署数分钟）。平台通过本会话的 waf 模块栈确认 Web ACL 属于你；
托管规则组 Block 返回的是 CloudFront 的 403，不带应用路径头，所以浏览器里看到的响应头只用于观察，拦截位置以**源站是否收到请求**为准。
