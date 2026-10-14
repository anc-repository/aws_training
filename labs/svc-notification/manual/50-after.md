---
step: after
---

记录 after：同样的 20 条评论，这次每条事件只有一次 `Publish`。

```bash {runsOn=workstation}
npm run exp -- notification --label after --scenario fanout --upload
npm run exp:report -- notification
```

::experiment{module=notification id=fanout label=after}

:::expected
报告中 before 的投递渠道是 `email`，after 是 `sns` + `sqs-copy`（每条事件各 1 行）；after 的 `notification` 段是一次 Publish 的耗时，
与订阅者数量无关。邮箱里的通知邮件发件人是 AWS Notifications，纯文本，底部有退订链接。
:::

:::tip
功能对照（选读）：`npm run exp -- notification --label after --scenario compare` 调用 `POST /api/lab/notification/compare`，
把同一个 `report.ready` 测试事件分别经 db 与 sns 驱动各发一次，并排显示耗时与调用次数（端点由集成阶段登记，返回 404 时跳过）。
:::

::checks
