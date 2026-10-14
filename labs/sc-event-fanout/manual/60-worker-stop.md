---
step: worker-stop
---

worker 停机时会怎样？运行器每 5 秒评论一次，在第 5 秒经平台管理通道（SSM）停止 `cloudalbum-worker`、第 50 秒再启动，
期间记录收件队列深度与 `sqs-copy` 投递记录的补齐情况：

```bash {runsOn=workstation}
npm run exp -- notification --label after --scenario worker-stop --fault-via ssm --instance-id {{ target.instanceId }} --upload
```

::experiment{module=notification id=worker-stop label=after}

运行期间可以另开一个工作台终端看收件队列：

```bash {runsOn=workstation}
aws sqs get-queue-attributes --queue-url "{{ var.inboxUrl }}" --attribute-names ApproximateNumberOfMessages
```

结束后确认 worker 已经恢复：

```bash {runsOn=lab}
systemctl is-active cloudalbum-worker
```

最后在邮箱里把两封邮件放在一起看：一封是这一步的“评论通知”（经 SNS），一封是第 3 步的“验证码 / 重置密码”（经 SES）。
对照发件人、正文格式与邮件底部。

:::expected
评论照常成功（Publish 在 api 进程里，与 worker 无关），通知邮件照常到达；停机期间收件队列积压，worker 启动后被消费，
`/api/admin/notifications/deliveries` 中的 `sqs-copy` 记录补齐；`systemctl is-active` 输出 `active`。
:::

:::tip
没有可用的投递通道时，用 `--fault-via skip` 运行，并按提示在实验机终端手工执行 `sudo systemctl stop cloudalbum-worker` 与 `sudo systemctl start cloudalbum-worker`。
:::

::checks
