# sc-event-fanout 变更说明

## 1.0.0

- 事件扇出与通知：第一版内容（04 v2）：lab.yaml、手册、检查、小测、开始与完成两张架构图；status 由 planned 改为 beta。
- 与卡片文档（scenario-cards §3.5）的差异见 lab.yaml 文件头注释与 docs/implementation-notes.md 的 wave1-scenarios 小节：
  recipient-emails 改为 notify-email 的 +u1、+u2 别名；SES 身份由 scripts/module enable email 创建（文档第 2、3 步合并）；
  用户订阅用 experiments/notification/subscribe-users.ts（enable 带 --no-migrate）；“SNS 邮件 vs SES 邮件”改为邮箱中的手动对照。
- notification、email 的公共检查引用 svc-notification、svc-email 的同名检查：两卡主版本变化时本卡必须同步提升版本。
