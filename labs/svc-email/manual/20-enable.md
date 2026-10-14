---
step: enable
---

接入 SES。模块会创建邮箱身份 `{{ learner.inputs.ses-identity }}`（已存在时只读接入）、配置集（信誉指标、配置集级抑制 BOUNCE / COMPLAINT）、
事件主题与反馈队列（+ DLQ）、以 `category` 标签为维度的 CloudWatch 事件目标，以及只允许从本身份发信的客户托管策略
（`ses:SendEmail` 用 `ses:FromAddress` 条件限定）。

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
脚本看到“已验证”才写 env、重启进程，并向 SES 邮箱模拟器发一封探针邮件。15 分钟内没验证会以退出码 5 结束（栈保留），
验证后重新执行同一条命令即可。
:::

验证完成后，在应用预览用 `success+demo@simulator.amazonses.com` 注册一个新用户（SES 邮箱模拟器在沙盒中也能收信），
然后看能力状态：

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.email | {driver, status, detail}'
```

::console-link[在 SQS 控制台打开反馈队列]{link=sqs.queue queueUrlEncoded="{{ var.feedbackUrl | url }}"}

:::expected
email 的驱动是 `ses`；沙盒中状态为黄色，detail 以“沙盒：只能发给已验证地址 · 今日已发 n / 上限 m”开头（上限取自 `GetAccount`），
这是预期的，不是故障。注册请求的路径头里有 `email=ses:sent`。
:::

:::saa{domain=secure confusable="SES 沙盒 vs 生产访问"}
新账号的 SES 按区域处于沙盒：只能发给已验证的地址、域名与邮箱模拟器，发送量与速率都很低。生产访问要单独申请、人工审核；
换区域要重新申请。
:::

::checks
