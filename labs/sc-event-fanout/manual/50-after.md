---
step: after
---

记录 **after**：与第 2 步相同的 20 条评论，这次每条事件只有一次 `Publish`。

```bash {runsOn=workstation}
npm run exp -- notification --label after --scenario fanout --upload
npm run exp:report -- notification
```

::experiment{module=notification id=fanout label=after}

:::expected
before 的投递渠道是 `email`，after 是 `sns` + `sqs-copy`（每条事件各 1 行）；after 的 `notification` 段是一次 Publish 的耗时，与订阅者数量无关。
邮箱里的通知邮件发件人是 AWS Notifications，纯文本，底部有退订链接。
:::

:::tip
功能对照（选读，不上传）：`npm run exp -- notification --label after --scenario compare` 调用 `POST /api/lab/notification/compare`，
把同一个测试事件分别经 db 与 sns 驱动各发一次，并排显示耗时与调用次数（端点由集成阶段登记，返回 404 时跳过）。
:::

:::why
**SNS + SQS 扇出 vs 一个 SQS 队列。** 一个队列是竞争消费：三个下游一起消费同一个队列，每条消息只会被其中一个处理。
SNS 主题 + 每个下游一个 SQS 队列，每个下游都有自己的副本与缓冲，一个下游暂时不可用不会丢消息，也不会拖慢别人。
:::

::checks
