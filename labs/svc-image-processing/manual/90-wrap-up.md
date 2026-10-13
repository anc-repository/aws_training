---
section: wrap-up
---

## 你做到了什么

- 把缩略图从 EC2 上的 sharp 搬到 S3 → EventBridge → Lambda：上传完成接口只剩一次数据库更新，EC2 CPU 不再随上传量起伏。
- 看懂了异步调用的重试、最大事件年龄与失败目标，并区分了永久错误与暂时错误。
- 亲手踩了一次“紧急刹车”，并确认它已解除。

## 考点回顾

- Lambda 的同步、异步与事件源映射三种调用；异步调用的重试（0～2 次）、最大事件年龄、Destinations 与 DLQ。
- S3 事件通知 vs EventBridge vs SNS 扇出；编舞与编排；输入输出分离避免递归。
- 预留并发与预置并发、账号并发配额；冷启动与 `Init Duration`；内存与 CPU 成比例、arm64 的性价比。
- 15 分钟超时、`/tmp`、部署包与 Layer / 容器镜像；Lambda 访问不到 EBS，状态必须外置。
