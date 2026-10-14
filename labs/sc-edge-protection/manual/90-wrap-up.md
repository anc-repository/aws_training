---
section: wrap-up
---

## 你做到了什么

- 从 L0 出发建了 CloudFront 分配，并在同一次启用中把直连入口只留给管理员 IP；源站 8080 只接受 CloudFront 前缀列表 + `X-Origin-Verify`。
- 在 us-east-1 建了 CLOUDFRONT 范围的 Web ACL：登录与全站两条速率规则、IP 集合、四组 AWS 托管规则；先 Count 观察误杀，再切到 Block。
- 用源站日志的 nonce 计数证明：被 WAF 拦截的请求根本没有到达 EC2；用安全组规则与 CloudShell 直连证明：攻击者绕不过边缘。

## 整体对比

| 指标 | 开始时 | 完成后 |
|---|---|---|
| 恶意请求在哪里被处理 | EC2 上的 Nginx | CloudFront 边缘的 WAF |
| 攻击期间源站收到的请求 | 随攻击线性上升，被拒绝的也都到达实例 | 被拦截的请求不回源，源站负载基本平稳 |
| 绕过防护的路径 | 不存在“防护层”可绕 | 80/443 只对管理员 IP 开放，8080 只接受本分配 |
| 恶意载荷识别 | 几条手写正则，编码变体漏网 | 托管规则组持续更新 |
| 多实例下的限额 | 每台实例各自计数 | Web ACL 全局计数 |
| DDoS 基础防护 | 无 | Shield Standard 自动生效 |
| 可观测性 | Nginx 日志汇总 | 采样请求、CloudWatch 指标、WAF 日志（us-east-1） |

## 考点回顾

- WAF 的挂载点（CloudFront、ALB、API Gateway REST API、AppSync、Cognito User Pool 等）与不能挂的资源（EC2、弹性 IP、NLB）；CLOUDFRONT 范围在 us-east-1。
- Web ACL、规则组、托管规则组、基于速率的规则、IP 集合、地理匹配；Count 模式、规则动作覆盖、范围缩小语句与 WCU。
- 源站保护：CloudFront 托管前缀列表 + 自定义请求头；S3 源用 OAC；VPC 源（VPC Origin）让源站完全没有公网入口。
- 安全组 / NACL（三/四层）与 WAF（七层）的分工；在 CloudFront 后面按 `X-Forwarded-For` 获取真实客户端 IP。
- Shield Standard 与 Shield Advanced；Firewall Manager；GuardDuty 只检测不阻断，与 WAF 互补。
