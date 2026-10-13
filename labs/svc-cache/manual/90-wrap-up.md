---
section: wrap-up
---

## 你做到了什么

- 给时间线加上 ElastiCache（Valkey）旁路缓存，用同一部署内的逐请求 A/B 证明命中时查库次数降到 0。
- 亲手验证了 ElastiCache 只能在 VPC 内访问，以及“安全组引用安全组”的放行方式。

## 考点回顾

- cache-aside 与 write-through、TTL 与失效策略；击穿、雪崩与 single-flight。
- Valkey / Redis OSS 与 Memcached；集群模式与非集群模式；Serverless 与节点模式的计费差异；Multi-AZ 需要至少一个副本。
- 只能在 VPC 内访问、TLS、AUTH / RBAC；缓存层次：CloudFront、API Gateway 缓存、ElastiCache、DAX、只读副本。
- 会话外置是 Auto Scaling 组无状态化的前提。
