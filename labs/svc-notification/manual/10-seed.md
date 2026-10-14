---
step: seed
---

先准备 3 个测试用户。脚本经应用的公开 API 注册 `+u1`～`+u3` 三个子地址，用 `/admin/outbox` 中的验证码完成邮箱验证，
各上传一张公开的小照片（之后给它们发评论），打开“邮件通知”，再把它们设为管理员（用来测“管理员广播”）。

```bash {runsOn=workstation}
npm run exp:login -w @cloudalbum/experiments
npx tsx experiments/notification/seed-users.ts --count 3 --email {{ learner.inputs.notify-email }}
```

清单写在工作台的 `.cloudalbum/experiments/notification-users.json`（0600，含这 3 个测试账号的密码，只用于本实验）。

:::why
**为什么都设为管理员？** db 驱动对“管理员广播”（例如日报完成）逐个发给全部管理员；SNS 侧则用一个过滤策略
`{"$or":[{"userId":[…]},{"audience":["admin"]}]}` 让每位管理员也收到广播。两边对比时接收人是同一批人。
:::

在应用预览打开“设置”：邮件通知已开启，并且是立即生效的——db 驱动只改一个布尔值，不需要任何确认。

:::expected
脚本为每个用户打印一行 `u1  you+u1@…  admin  photo=…  邮件通知=on（db）`；capabilities 中 notification 的驱动是 `db`。
:::

::checks
