---
section: cleanup
---

- 主题、收件队列与订阅级 DLQ 随会话回收删除；主题删除后，所有订阅（包括还没确认的）随之删除，待确认的订阅本来也会自动过期。
- 邮箱里收到的确认邮件与通知邮件留在你的邮箱中，无需处理。
- 测试用户、站内信与 `notification_prefs` 都在实验机的数据库里，随实验机删除；工作台上的 `notification-users.json` 随工作台删除。
- 在独立模式下手工停用：`scripts/module disable notification --no-migrate`（迁移框架接入前；删除主题即删除剩余订阅）。
