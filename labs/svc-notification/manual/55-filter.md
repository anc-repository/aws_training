---
step: filter
---

只给 `+u1` 发一条事件，看过滤策略的效果。运行器给 u1 的照片发一条评论（消息属性 `userId=<u1 的 ID>`），
然后从服务端读这条事件的投递记录：

```bash {runsOn=workstation}
npm run exp -- notification --label after --scenario filter --param user=u1 --upload
```

::experiment{module=notification id=filter label=after}

到邮箱核对：这条只有收件人为 `+u1` 的邮件到达，`+u2`、`+u3` 没有（所有别名都进同一个邮箱，按收件人地址区分）。

:::wait{typical=3 max=10}
SNS 的 CloudWatch 指标有分钟级延迟：`NumberOfNotificationsFilteredOut` 通常在几分钟后出现。
:::

:::expected
filter 的 `emailedOthers` 为 0，服务端只有一行 `sns` 与一行 `sqs-copy`（收件队列不设过滤策略，收到全部事件）；
CloudWatch 中本主题的 `NumberOfNotificationsFilteredOut` 大于 0。
:::

:::saa{domain=resilient confusable="SNS 过滤策略 vs 应用代码判断"}
过滤在 SNS 侧完成，不需要改应用代码；作用范围可以是消息属性（默认）或消息体（`FilterPolicyScope=MessageBody`）。
需要顺序与去重时用 SNS FIFO 主题 + SQS FIFO 队列。
:::

::checks
