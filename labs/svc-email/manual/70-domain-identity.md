---
step: domain-identity
---

有自有域名时，改用**域名身份**：开启 Easy DKIM，SES 生成 3 条 CNAME。域名是 `{{ learner.inputs.domain }}`（建议用子域，例如 `mail.<你的域名>`）。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable email --param Domain={{ learner.inputs.domain }} --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable email --param Domain={{ learner.inputs.domain }}
```
:::

脚本打印 `InfoDkimRecords`：3 条 `<token>._domainkey.<域名> CNAME <token>.dkim.amazonses.com`。到你的 DNS 服务商原样添加
（启用了 dns 模块时由栈写入 Route 53）。

:::wait{typical=10 max=20}
DNS 生效后 SES 才能验证域名、DKIM 状态变为“成功”；脚本轮询到“已验证”才写 env。
:::

:::expected
`aws sesv2 get-email-identity --email-identity {{ learner.inputs.domain }}` 的 `DkimAttributes.Status` 为 `SUCCESS`；
之后发出的邮件 `DKIM-Signature` 的 `d=` 是你的域名，与发件域对齐。
:::

:::tip
结束后记得删除你在外部 DNS 服务商手动添加的 DKIM 记录。
:::

::checks
