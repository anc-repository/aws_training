---
section: wrap-up
---

## 你做到了什么

- 给相册一个固定域名：邮件、分享链接、`APP_BASE_URL` 都不再绑定 IP。
- 用换 IP 演练证明了“名字固定、目标可换”：旧 IP 链接一直失败，域名链接在 TTL 量级的时间内恢复。
- 亲手确认 Alias 直接返回 A 记录，区域顶点不能建 CNAME。

## 考点回顾

- 公有与私有托管区域；私有托管区域要求 VPC 开启 DNS 支持与 DNS 主机名。
- A、AAAA、CNAME 与 Alias：根域名只能用 Alias；指向 AWS 资源的 Alias 查询免费；Alias 不能指向 IP 或弹性 IP。
- TTL 与缓存：迁移前先调低 TTL。
- 路由策略：简单、加权、延迟、故障转移、地理位置、地理邻近、多值应答、基于 IP；健康检查类型与 Evaluate Target Health。
- 域名注册与 DNS 托管是两件事；NS 委派；删除后重建托管区域会得到新的 NS。
