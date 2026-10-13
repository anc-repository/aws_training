---
section: wrap-up
---

## 你做到了什么

- 认识了 L0 的组成：实例、根卷与独立数据卷、弹性 IP、安全组、IMDSv2，以及只用于平台管理通道的实例角色。
- 确认了数据与机密在数据卷上——实例可替换；也亲手证明了它仍是单点。

## 考点回顾

- EBS 卷与实例的生命周期相互独立、`DeleteOnTermination` 的默认值、EBS 绑定 AZ 与快照跨 AZ / 跨区域。
- 实例存储与 EBS 的持久性差异；弹性 IP 与公网 IPv4 计费。
- IMDSv2、跳数限制与 SSRF；User Data 与 `CreationPolicy` + `cfn-signal`；用 SSM 公共参数解析最新 AMI。
- T 系列 CPU 积分（standard / unlimited）；安全组有状态、只有允许规则；高可用与“有备份”的区别。
