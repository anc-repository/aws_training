---
section: wrap-up
---

## 你做到了什么

- 安全组没有任何管理端口入站，照样登录实例、做端口转发。
- 不再需要分发和轮换 SSH 私钥：登录用 IAM 身份，授权可以细到实例标签与 Session 文档。
- 回答了“谁在什么时间执行了什么命令”：会话历史、会话日志与 CloudTrail 对齐。

## 考点回顾

- Session Manager、堡垒机、EC2 Instance Connect、EC2 Instance Connect Endpoint：谁需要 22 端口、谁需要公网 IP、各自怎么审计。
- SSM 托管节点的三个前提；最小暴露面：零入站规则、安全组有状态。
- 私有子网访问 AWS 服务：NAT Gateway 与 Interface Endpoint；Session Manager 需要 `ssm`、`ssmmessages`（以及建议保留的 `ec2messages`）。
- 用 IAM 条件键（`ssm:resourceTag/*`）控制谁能登录哪些实例；按 Session 文档控制能否做端口转发。
- AWS 托管策略 `AmazonSSMManagedInstanceCore` 与客户托管最小权限策略的取舍。
