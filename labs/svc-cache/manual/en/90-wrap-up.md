---
section: wrap-up
---

## What you did

- Added ElastiCache (Valkey) cache-aside to the timeline and proved with a per-request A/B in the same deployment that hits bring database queries down to 0.
- Verified for yourself that ElastiCache is only reachable inside the VPC, and how a security group that references another security group grants access.

## Exam points recap

- Cache-aside vs write-through; TTLs and invalidation strategies; cache breakdown, avalanches and single-flight.
- Valkey / Redis OSS vs Memcached; cluster mode enabled vs disabled; how Serverless and node-based billing differ; Multi-AZ needs at least one replica.
- Reachable only inside the VPC, TLS, AUTH / RBAC; caching layers: CloudFront, API Gateway caching, ElastiCache, DAX, read replicas.
- Moving sessions out of the instance is the prerequisite for a stateless Auto Scaling group.
