---
section: wrap-up
---

你完成了：

- WAF 的挂载点（CloudFront、ALB、API Gateway REST API 等）与不能挂的资源（EC2、EIP、NLB）；
- CLOUDFRONT 范围的 Web ACL、IP 集合、日志组都在 **us-east-1**；
- 托管规则组先 Count 后 Block，CRS 的 `SizeRestrictions_BODY` 对大请求体的误杀与覆盖；
- 速率规则按窗口聚合、有检测延迟，与 Nginx 精确限速的差别；
- 源站锁定与“绕过 WAF”，以及为什么要用**服务端证据**判断拦截位置。
