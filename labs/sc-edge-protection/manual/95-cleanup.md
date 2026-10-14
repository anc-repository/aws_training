---
section: cleanup
---

- 自动回收先用空的 `WebAclArn` 更新 cdn 栈**解除关联**（分配重新部署数分钟），再删除 us-east-1 的 Web ACL 与 IP 集合——仍处于关联状态的 Web ACL 无法删除。
- 然后禁用并删除分配，删除源站安全组、缓存策略与 8080 监听器；实验机随会话删除，80/443 的收紧随之消失。
- WAF 日志组 `{{ var.logGroup }}` 在 **us-east-1**，按数据保护约定保留到回收器清理阶段；自己在 Logs Insights 查询时记得切到 us-east-1。
- 如果你为别的练习设置过 `WAF_LAB_ALLOW_CIDR`，结束前清空：它是 Allow 动作，会让该地址跳过全部规则。
- 本卡没有订阅 Shield Advanced，也没有启用 GuardDuty，账号级状态不需要处理。
