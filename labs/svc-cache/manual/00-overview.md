---
section: overview
---

## 背景

L0 的时间线每次都查库（`CACHE_DRIVER=none`）。时间线是典型的读多写少接口：同一个人的时间线在几十秒内被反复读取，内容几乎不变。
旁路缓存（cache-aside）先读缓存，未命中再查库并回填；写入时递增版本号，让旧键自然失效。
这张卡片在默认 VPC 里建一个单节点的 Amazon ElastiCache（Valkey），让多个进程、多台实例共享同一份缓存。

:::why
缓存是**非权威**端口：真正的数据在数据库里。缓存连不上时应用按未命中处理（fail-open），请求变慢但不失败，模块标为 degraded。
所以缓存故障从来不应该变成用户可见的错误。
:::

## 对比实验预告

### 时间线读压测（cache/feed-read，必做）

- **没有缓存（none）**：每次时间线请求都执行若干次数据库查询。
- **有了 ElastiCache**：命中时每请求的数据库查询为 0；after 用 `--ab` 在同一部署内逐请求交替旁路缓存，A / B 两组同时段可比。
- **你会在哪里看到**：对比报告中的 `client.timing.database.calls_per_request` 与命中率 `client.outcome_ratio.cache.hit`；
  响应头 `X-CloudAlbum-Path` 的 cache 段从 `none` 变为 `redis@elasticache:hit` / `miss`。
- **如果结果不符合预期**：SQLite 在本机、数据量小，延迟差异可能不明显——看每请求查库次数，而不只看 p95；单进程下进程内缓存（memory）的命中反而更快。

## 平台模式说明

ElastiCache 节点从创建开始按小时计费；对比实验在工作台运行。工作台和实验机同在默认 VPC，但只有实验机能连到缓存——第 5 步会亲手验证。
