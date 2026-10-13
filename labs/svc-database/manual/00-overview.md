---
section: overview
---

## 背景

L0 的用户、相册与照片元数据在 EBS 上的一个 SQLite 文件里，与 Node 同进程读写。它简单、低延迟，但有三个硬伤：
单写者，高并发写时同步驱动阻塞事件循环；EC2 一停，数据库跟着停；备份和数据在同一块盘上。
这张卡片把数据库换成 Multi-AZ 的 Amazon RDS for PostgreSQL：应用的 Knex 仓储代码不变，换来托管备份、时间点恢复与自动故障转移。

:::why
**换成 RDS 不会让单次查询变快**：每次查询多一次同 VPC 的网络往返。RDS 换来的是运维属性——备份、补丁、监控、故障转移——
以及不再与应用进程争抢同一个事件循环。
:::

## 对比实验预告

### 混合读写（database/mixed-rw，必做）

- **没有 RDS（SQLite）**：低并发时进程内查询最快；50 个并发时写入排队，事件循环延迟 P99 出现尖峰。
- **有了 RDS**：低并发时单次请求略慢（多一次网络往返）；高并发时延迟平缓上升，事件循环不再被阻塞。
- **你会在哪里看到**：对比报告中按并发阶段（`client.byStage`）的时间线 p50 / p95、`host.event_loop_delay.p99` 与错误率；
  响应头 `X-CloudAlbum-Path` 的 database 段从 `sqlite` 变为 `postgres@rds`。

### 故障与恢复（database/failover，必做）

- **SQLite**：运行器在第 30 秒重启 api，写入中断直到进程恢复。
- **RDS Multi-AZ**：运行器在第 30 秒强制故障转移，应用经历一段写失败后自动重连（时长以官方文档与实测为准）。

## 平台模式说明

Multi-AZ 的主库与备库都按实例小时计费，做完必需步骤就可以提前结束实验。对比实验在工作台运行；
故障转移由运行器在工作台用你的身份执行 `aws rds reboot-db-instance --force-failover`。
