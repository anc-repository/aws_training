---
step: enable
---

接入 SNS。模块会创建主题 `notification-events`、收件队列 `notification-inbox`（原始消息传递、不设过滤策略）、订阅级 DLQ
`notification-dlq`，以及一个给运维兜底邮箱的邮件订阅（过滤策略 `{"audience":["admin"]}`）。运维邮箱请用你邮箱的 `+admin` 别名，
例如通知邮箱是 `{{ learner.inputs.notify-email }}` 时，在 `@` 前加 `+admin`。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable notification --param AdminEmail=<你的邮箱的 +admin 别名> --no-migrate --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable notification --param AdminEmail=<你的邮箱的 +admin 别名> --no-migrate
```
:::

`--no-migrate`：已开启邮件通知的用户，下一步用 `subscribe-users.ts` 逐个建订阅（与迁移脚本走同一个 `subscribeEmail`）。

:::wait{typical=4 max=20}
部署主题与两条队列通常一两分钟。完成后到运维邮箱找 “AWS Notification - Subscription Confirmation”，点击 **Confirm subscription**。
确认之前，notification 的状态是黄色“运维订阅待确认”——这是预期的等待，不是失败。
:::

确认之后，在应用预览给 `+u1` 的照片发一条评论，然后看这个请求的响应头：

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.notification | {driver, status, detail}'
```

:::why
**为什么邮件订阅要确认？** 任何人都能把别人的地址订阅到自己的主题上；只有收件人点了确认链接，SNS 才开始投递。
这也是 SNS 不适合发注册验证码这类事务性邮件的原因之一（发件人是 AWS Notifications、只能纯文本、每封都带退订尾注）。
:::

::console-link[在 SQS 控制台打开收件队列]{link=sqs.queue queueUrlEncoded="{{ var.inboxUrl | url }}"}

:::expected
notification 为“正常”，detail 形如 `主题 cloudalbum-…-notification-events · 已确认订阅 2 · 待确认 0 · 收件队列 0 · 订阅级 DLQ 0`；
评论请求的路径头里有 `notification=sns:published`；收件队列的访问策略只允许本主题（`aws:SourceArn`）以 `sns.amazonaws.com` 身份发送。
:::

:::saa{domain=secure confusable="主题策略 vs 队列策略"}
SNS 投递到 SQS 时，写入权限由**队列策略**授予 `sns.amazonaws.com`，并用 `aws:SourceArn` 限定为哪个主题（防止混淆代理人）；
主题策略决定谁能向主题发布。队列若用 CMK 加密，密钥策略也必须授权 `sns.amazonaws.com`，否则投递静默失败。
:::

::checks
