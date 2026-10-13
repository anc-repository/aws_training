---
section: wrap-up
---

## 你做到了什么

- 在私有 S3 桶前加了 CloudFront：缩略图 URL 变为稳定的 `https://<分配域名>/media/variants/…`，边缘与浏览器都能缓存。
- 用 OAC + `AWS:SourceArn` 让桶保持私有、BPA 全开，只对本分配开放 `variants/*`。
- 比较了失效与版本化文件名。

## 整体对比

- **媒体 URL**：每次不同的预签名 URL → 稳定的分配域名地址。
- **源站负载**：每个请求都到 S3 或 EC2 → 只剩回源请求。
- **桶的暴露面**：私有、靠预签名 URL → 私有、只允许本分配经 OAC 读取 `variants/*`。
- **按小时计费的资源**：不变（新增服务都按量计费）。

## 考点回顾

- 边缘站点与区域边缘缓存；缓存策略、源请求策略、响应头策略；TTL 与 `Cache-Control`。
- OAC 与 OAI；只允许 CloudFront 访问 S3 的桶策略；SSE-KMS 对象需要密钥策略授权 CloudFront。
- CloudFront 使用的 ACM 证书必须在 us-east-1；Route 53 Alias 可用于根域名、指向 AWS 资源的查询不收费；根域名不能有 CNAME。
- CloudFront、S3 Transfer Acceleration、Global Accelerator 的对比；从 AWS 源站到 CloudFront 的传输免费。
