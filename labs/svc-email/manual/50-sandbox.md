---
step: sandbox
---

沙盒里发给一个**没有验证过**的地址会怎样？选一个你能控制、但没有在 SES 验证过的地址（不要用 example.com 等保留域名——
EmailPort 不会为它们调用 SES）。运行器用它注册一个测试用户，验证邮件交给 EmailPort，然后读服务端的发送记录：

```bash {runsOn=workstation}
npm run exp -- email --label after --scenario sandbox --param to=<一个未验证的地址>
aws sesv2 get-account --query "{production:ProductionAccessEnabled,quota:SendQuota}"
```

::experiment{module=email id=sandbox label=after}

在 `/admin/outbox` 中找到这封验证邮件。

:::expected
状态 `failed`（标红），错误 `MessageRejected: Email address is not verified …`，路径段 `email=ses:rejected`；
`get-account` 显示 `production: false`。如果设置了 `EMAIL_SANDBOX_POLICY=outbox`，被拒的邮件会改写进本机 outbox，同样标注“未真正发出”。
:::

:::why
SES 适配器不会悄悄把失败的邮件改写成“已发送”：非权威端口失败时记 `failed`，模块状态变为 degraded，注册本身不受影响。
`EMAIL_SANDBOX_POLICY=outbox`（`scripts/module enable email --set EMAIL_SANDBOX_POLICY=outbox`）是显式选择的演示选项，方便沙盒期注册的新用户
在 `/me/outbox` 里完成验证。
:::

::checks
