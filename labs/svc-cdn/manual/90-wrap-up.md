---
section: wrap-up
---

## 你做到了什么

- 把 EC2 直出的相册放到 CloudFront 后面：静态资源与缩略图在边缘缓存，命中时不回源。
- 用服务端证据（源站日志中的 nonce 次数）证明了“边缘命中”，而不是相信可以伪造的响应头。
- 确认认证类接口在 `CachingDisabled` 的行为里，两次请求都回源。
- 比较了失效与版本化文件名。

## 考点回顾

- 缓存策略决定缓存键与 TTL，源请求策略决定回源时带什么，响应头策略决定返回给浏览器的头。
- 自定义源站只能是域名；用托管前缀列表 + 自定义头保护源站；S3 源站用 OAC。
- CloudFront 使用的 ACM 证书必须在 us-east-1；从 AWS 源站回源到 CloudFront 的流量不收出网费。
- CloudFront 缓存内容，Global Accelerator 不缓存、提供静态 Anycast IP。
