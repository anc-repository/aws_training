---
step: enable-email
---

接入 SES。模块会创建邮箱身份 `{{ learner.inputs.ses-identity }}`（已存在时只读接入）、配置集（信誉指标、配置集级抑制 BOUNCE / COMPLAINT）、
事件主题与反馈队列（+ DLQ），以及只允许从本身份发信的客户托管策略。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable email --param Email={{ learner.inputs.ses-identity }} --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable email --param Email={{ learner.inputs.ses-identity }}
```
:::

:::wait{typical=5 max=20}
栈部署完成后，脚本每 15 秒查询一次身份状态。到邮箱找 “Amazon Web Services – Email Address Verification Request”，点击链接；
脚本看到“已验证”才写 env、重启进程。15 分钟内没验证会以退出码 5 结束（栈保留），验证后重新执行同一条命令即可。
:::

验证完成后，让一封事务邮件**真正**到达你的收件箱：在应用预览退出登录，用 `{{ learner.inputs.ses-identity }}` 注册一个新用户
（如果这个地址已经注册过，就在登录页用“忘记密码”给它发一封重置邮件）。然后看能力状态与账户的沙盒状态：

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.email | {driver, status, detail}'
```

```bash {runsOn=workstation}
aws sesv2 get-account --query "{production:ProductionAccessEnabled,quota:SendQuota}"
aws sns list-subscriptions-by-topic --topic-arn "{{ var.emailEventsTopicArn }}" --query "Subscriptions[].[Protocol,Endpoint]" --output table
```

::console-link[在 SQS 控制台打开反馈队列]{link=sqs.queue queueUrlEncoded="{{ var.feedbackUrl | url }}"}

:::expected
邮件到达你的收件箱，注册请求的路径头里有 `email=ses:sent`；email 的驱动是 `ses`，沙盒中状态为黄色，detail 以“沙盒：只能发给已验证地址”开头——
这是预期的，不是故障；`get-account` 显示 `production: false`；SES 事件主题只有一个订阅：协议 `sqs`，指向 `cloudalbum-{{ session.env }}-email-feedback`。
:::

:::why
**退信为什么要回到应用？** 退信率或投诉率过高时，账号会被审查甚至暂停发送（阈值以官方文档为准）。配置集 → SNS → SQS 让应用主动拉取这些事件：
实验机只发起出站连接，不需要入站端口；worker 停机期间事件留在队列里，恢复后照常处理。
:::

:::saa{domain=secure confusable="SES 沙盒 vs 生产访问"}
新账号的 SES 按区域处于沙盒：只能发给已验证的地址、域名与邮箱模拟器，发送量与速率都很低。生产访问要单独申请、人工审核；换区域要重新申请。
:::

::checks
