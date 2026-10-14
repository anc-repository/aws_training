---
section: cleanup
---

会话结束时平台自动回收：先用空的 `WebAclArn` 更新 cdn 栈**解除关联**（分配重新部署数分钟），再删除 us-east-1 的 Web ACL 与 IP 集合——仍处于关联状态的 Web ACL 无法删除。

- WAF 日志组 `{{ var.logGroup }}` 在 **us-east-1** 且按数据保护约定**保留**；自己在 Logs Insights 查询时记得切到 us-east-1。
- 如果为别的实验设置过 `WAF_LAB_ALLOW_CIDR`，结束前清空：它是 Allow 动作，会让该地址跳过全部规则。
