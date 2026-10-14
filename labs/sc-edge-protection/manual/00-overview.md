---
section: overview
---

## 背景

相册上线一个月后，登录接口每天收到成千上万次撞库尝试，访问日志里满是 `/wp-login.php`、`/.env` 之类的扫描。起点是 L0：入口是实验机的弹性 IP，
防护只有实例上的 Nginx——`limit_req` 限速、几条正则和一个 `denylist.conf`。它们能挡住一部分，但**每个恶意请求都已经到达 EC2**，
消耗了实例的连接、TLS 与带宽。

这张卡片从 L0 出发，亲手完成三件事：在实例前面建 CloudFront 分配，并把直连入口只留给管理员 IP；在 us-east-1 建 Web ACL 并关联到分配，
托管规则组先 Count 观察误杀再切到 Block；最后用源站日志证明“被拦截的请求根本没有到达 EC2”。

## 架构

### 开始时

![开始时：攻击者与用户都直接打实验机的弹性 IP，防护只有 Nginx](assets/arch-start.svg)

### 完成后

![完成后：流量先经 CloudFront 与 us-east-1 的 Web ACL，源站 8080 只放行 CloudFront 前缀列表与校验头，直连只对管理员 IP 开放](assets/arch-end.svg)

## 为什么组合在一起

- **WAF 必须依附一个入口**：它不能关联 EC2、弹性 IP 或 NLB，只能挂在 CloudFront、ALB、API Gateway REST API 等资源上（DEP-006）。
  本卡选 CloudFront：TLS 终止与 WAF 检查都在边缘完成，被拦截的请求不进入东京区域，也没有按小时计费的负载均衡器。
- **CLOUDFRONT 范围在 us-east-1**：Web ACL、IP 集合与 WAF 日志组都建在 us-east-1（栈 `cloudalbum-{{ session.env }}-waf-edge`），
  与应用所在的 ap-northeast-1 分开。
- **锁定源站才算数**：实验机 80/443 只对管理员 IP 开放；8080 源站监听器只放行 CloudFront 托管前缀列表，Nginx 再校验只有本分配知道的
  `X-Origin-Verify`。只开 WAF 不锁源站，攻击者直接打弹性 IP 就绕过了全部规则（DEP-018）。
- **Shield 与 GuardDuty 各管一层**：Shield Standard 对所有 CloudFront 分配自动生效，抵御常见的网络层与传输层 DDoS；
  GuardDuty 分析 CloudTrail、VPC 流日志与 DNS 日志，只产生发现、不阻断，也不看 HTTP 内容。
- **常见错误组合**：只用前缀列表锁源站（别人的分配也来自这些网段）；把 Web ACL 建在 ap-northeast-1 再去关联分配；
  托管规则不经 Count 观察直接 Block（CRS 会误杀照片上传的大请求体）；为了防撞库购买 Shield Advanced。

## 对比实验预告

所有攻击都只针对你自己账号里的实验机，保持短轮次、略高于阈值的低速率，遵守 AWS 的渗透测试政策（以官方文档为准）。

### 限速（waf/flood，必做）

- **开始时**：从工作台以略高于阈值的速率打 `POST /api/auth/login`，Nginx 的 `limit_req` 几乎立即回 429，但每个请求都到达了实例。
- **完成后**：同样的攻击打向 CloudFront，速率规则按窗口聚合、有检测延迟（数十秒），被拦截的请求不回源。
- **你会在哪里看到**：报告中的拦截比例与第一次拦截的时间；服务端证据是源站访问日志里本次 nonce 的计数（`/api/lab/waf/origin`），不是客户端看到的响应头。

### 攻击载荷识别（waf/payloads，必做）

同一组公开的 WAF 测试载荷（SQL 注入及其编码变体、目录穿越、XSS、Log4Shell 探针、扫描器 User-Agent）分别打向两条路径。
Nginx 的几条正则会漏掉二次编码、大小写与注释变体；结果里的 `caughtOnlyByWaf` 列出 Nginx 漏掉而托管规则组拦住的变体。

### 误杀（waf/false-positive，必做）

在 Count 模式下发两个合法但“可疑”的请求：一个大于 8 KB 的请求体、一条含 `SELECT * FROM` 的正常文本，看是哪条规则会命中，
以及本模块为什么把 CRS 的 `SizeRestrictions_BODY` 覆盖为 Count。

### 为什么不用 waf/bypass

工作台的公网出口就是你设置的管理员 IP，从工作台探测 80 端口必然可达。本卡改用服务端证据证明“无法绕过”：实验机与源站安全组的规则、
实验机本机不带校验头请求 8080 得到 403，以及你在 CloudShell（不是管理员 IP）直连时的超时。

## 平台模式说明

- `scripts/module enable waf` 以学员身份在 us-east-1 部署栈 `cloudalbum-{{ session.env }}-waf-edge`，再把 `WebAclArn` 注入 cdn 栈，分配重新部署（数分钟）。
- 锁定源站后，平台 Lambda 访问不到实验机的公网入口，直连预览会被安全组挡住；应用预览改用分配域名，之后的直连类检查都从实验机本机发起。
- `WAF_LAB_ALLOW_CIDR` 必须保持为空：它是 Allow 动作，会让列出的地址跳过全部规则。
