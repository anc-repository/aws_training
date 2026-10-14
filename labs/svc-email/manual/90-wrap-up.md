---
section: wrap-up
---

## 你做到了什么

- 让同一份 MIME 经 SES 真正发出，`/me/outbox` 不再是“收到邮件”的替身；邮箱验证从此能证明归属。
- 用 SES 邮箱模拟器演练了投递、退信与投诉，事件经 SNS → SQS 回流并自动停止给退信地址发非必要邮件。
- 在原始邮件里看到了 DKIM 签名，体会了沙盒的限制。

## 考点回顾

- SES 身份验证（邮箱 / 域名）、Easy DKIM、SPF、DMARC、自定义 MAIL FROM。
- 沙盒与生产访问（按区域）；发送配额与最大发送速率。
- 配置集与事件目标（SNS、CloudWatch、Firehose、EventBridge）；退信与投诉、账户级与配置集级抑制列表、信誉指标与账号审查。
- SES 与 SNS 邮件订阅的区别；EC2 默认限制出站 25 端口；SMTP 接口（IAM 派生凭证）与 API 接口。
- Cognito 默认邮件与经 SES 发送（`scripts/module enable email --param ForCognito=true` 经 injects 把身份交给 auth）。
