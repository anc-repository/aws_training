---
section: cleanup
---

- logging 栈随会话回收删除；两个日志组是 `DeletionPolicy: Retain`，由回收器按“保留的资源”删除。
- 选做步骤安装的 CloudWatch Agent 片段随 hostSetup revert 移除，实验机随会话删除。
- 如果为了归档自己创建过订阅过滤器、Firehose 流或导出任务，它们不是 logging 栈的资源：不需要时结束前自己删除。
