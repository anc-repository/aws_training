---
step: worker-stop
---

worker 停机时会怎样？在实验机终端停止 worker：

```bash {runsOn=lab}
sudo systemctl stop cloudalbum-worker
```

在应用预览给测试用户的照片发几条评论，然后看收件队列：

```bash {runsOn=workstation}
aws sqs get-queue-attributes --queue-url "{{ var.inboxUrl }}" --attribute-names ApproximateNumberOfMessages
```

到邮箱看这几条评论的通知邮件，然后重新启动 worker：

```bash {runsOn=lab}
sudo systemctl start cloudalbum-worker
```

:::expected
评论照常成功（Publish 在 api 进程里，与 worker 无关），通知邮件照常到达；只有收件队列积压，worker 启动后被消费，
`/api/admin/notifications/deliveries` 中的 `sqs-copy` 记录补齐。
:::

:::tip
也可以让运行器自动完成停机与恢复：`npm run exp -- notification --label after --scenario worker-stop --fault-via ssm --instance-id {{ target.instanceId }}`
（第 5 秒停止、第 50 秒启动 worker，期间记录收件队列深度）。
:::

::checks
