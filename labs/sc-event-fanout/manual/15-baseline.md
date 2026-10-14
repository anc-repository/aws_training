---
step: baseline
---

记录 **before**：运行器以管理员身份给两位测试用户的照片随机发 20 条评论，每条产生一个 `comment.created` 事件；
然后从服务端读本次事件的投递记录（`GET /api/admin/notifications/deliveries`）。

```bash {runsOn=workstation}
npm run exp -- notification --label before --scenario fanout --upload
```

::experiment{module=notification id=fanout label=before}

在应用预览以管理员打开 `/admin/outbox`：每条评论都多了一封写进 outbox 的通知邮件，页面顶部写着“邮件未真正发出（本地 outbox）”。

:::expected
报告中 `deliveriesByChannel` 只有 `email`，每条事件 1 行；评论请求的 Server-Timing 中 `notification` 段包含了 EmailPort 的耗时。
两位用户的真实邮箱里什么也没有。
:::

:::why
db 驱动的耗时随接收人数线性增长：一张热门照片有几十个关注者时，发评论的请求就要等几十次邮件调用（`QUEUE_DRIVER=sync` 时全部算在请求里）。
:::

::checks
