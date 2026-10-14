---
step: baseline
---

先看本地 outbox：在右侧“应用预览”退出登录，用任意地址注册一个新用户。注册成功页提示“本站未启用真实邮件，验证邮件已写入 outbox”，
打开 `/me/outbox`，点击验证邮件里的链接完成验证——整个过程没有任何邮件离开 EC2。

再记录 before：运行器给 SES 邮箱模拟器的三个地址（success、bounce、complaint）与你的邮箱各注册一个测试用户并触发“找回密码”，
然后从服务端（`/api/admin/outbox`）读每封邮件的记录：

```bash {runsOn=workstation}
npm run exp:login -w @cloudalbum/experiments
npm run exp -- email --label before --scenario send-matrix --param to={{ learner.inputs.ses-identity }} --upload
```

::experiment{module=email id=send-matrix label=before}

:::expected
报告中四个地址的 `transport` 都是 `outbox`，`deliveryStatus` 都是 `none`；`/admin/outbox` 顶部写着“邮件未真正发出（本地 outbox）”。
:::

:::tip
选做的 register-latency 要和这里的 outbox 档对比时，现在顺手跑一次：
`npm run exp -- email --label before --scenario register-latency`（注册接口每 IP 10 分钟限 20 次）。
:::

::checks
