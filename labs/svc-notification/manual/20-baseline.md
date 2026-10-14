---
step: baseline
---

记录 before：运行器以管理员身份给 3 个测试用户的照片随机发 20 条评论，每条产生一个 `comment.created` 事件；
然后从服务端读本次事件的投递记录（`GET /api/admin/notifications/deliveries`）。

```bash {runsOn=workstation}
npm run exp -- notification --label before --scenario fanout --upload
```

::experiment{module=notification id=fanout label=before}

打开应用的 `/admin/outbox`：每条评论都多了一封写进 outbox 的通知邮件（本卡起始状态的 email 是 outbox，没有真正发出）。

:::expected
报告中 `deliveriesByChannel` 只有 `email`，每条事件 1 行；评论请求的 Server-Timing 里 `notification` 段包含了 EmailPort 的耗时
（`email` 段）。
:::

:::tip
db 驱动的耗时随接收人数线性增长：一条“管理员广播”要逐个发给全部管理员。功能对照端点 `/api/lab/notification/compare`
可用时，报告里还会出现 `broadcast_db_email_calls`（= 管理员人数）。
:::

::checks
