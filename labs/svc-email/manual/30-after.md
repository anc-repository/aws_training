---
step: after
---

记录 after：同样的四个地址，这次邮件经 SES 发出；运行器轮询 `/api/admin/outbox`，直到每封的投递状态由反馈事件更新（最长 3 分钟）。

```bash {runsOn=workstation}
npm run exp -- email --label after --scenario send-matrix --param to={{ learner.inputs.ses-identity }} --upload
npm run exp:report -- email
```

::experiment{module=email id=send-matrix label=after}

打开应用的 `/admin/outbox`：每行带 transport、SES MessageId 与投递状态徽章（已投递 / 退信 / 投诉）。
`bounce@simulator.amazonses.com` 对应的用户 `email_status` 变成了 `bounced`：之后只给它发验证与重置密码这两类必要邮件。

:::why
**为什么要处理退信和投诉？** 退信率或投诉率过高时，账号会被审查甚至暂停发送（阈值以官方文档为准）。反馈事件经
配置集 → SNS → SQS 回流，应用主动拉取，不需要入站端口；配置集级与账户级抑制列表是第二道保护。
:::

:::expected
before 全部是 `outbox / none`；after 中 success → `delivered`、bounce → `bounced`、complaint → `complained`，你的邮箱收到“重置密码”邮件；
反馈 DLQ 为 0。
:::

:::tip
功能对照（选读）：`npm run exp -- email --label after --scenario compare --param to={{ learner.inputs.ses-identity }}` 调用
`POST /api/lab/email/compare`，同一封邮件经 outbox 与 SES 各发一次，并排显示耗时（端点由集成阶段登记，返回 404 时跳过）。
:::

::checks
