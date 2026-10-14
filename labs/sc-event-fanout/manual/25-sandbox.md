---
step: sandbox
---

沙盒里发给一个**没有验证过**的地址会怎样？选一个你能控制、但没有在 SES 验证过的地址（不要用 example.com 等保留域名——EmailPort 不会为它们调用 SES）。
运行器用它注册一个测试用户，验证邮件交给 EmailPort，然后读服务端的发送记录：

```bash {runsOn=workstation}
npm run exp -- email --label after --scenario sandbox --param to=<一个未验证的地址> --upload
```

::experiment{module=email id=sandbox label=after}

在应用预览以管理员打开 `/admin/outbox`，找到这封验证邮件。

:::expected
状态 `failed`（标红），错误 `MessageRejected: Email address is not verified …`，路径段 `email=ses:rejected`；注册本身照常完成。
:::

:::why
SES 适配器不会把失败的邮件悄悄改写成“已发送”：非权威端口失败时记 `failed`，注册照常完成。`EMAIL_SANDBOX_POLICY=outbox`
（`scripts/module enable email --set EMAIL_SANDBOX_POLICY=outbox`）是显式选择的演示选项，本卡保持默认的 `fail`。
:::

::checks
