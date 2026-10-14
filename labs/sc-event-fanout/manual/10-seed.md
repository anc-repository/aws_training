---
step: seed
---

先准备两位测试用户。脚本经应用的公开 API 注册 `+u1`、`+u2` 两个子地址，用 `/api/admin/outbox` 里的验证码完成邮箱验证
（起点的 email 是 outbox，验证邮件不会真正发出），各上传一张公开的小照片，并打开“邮件通知”。`--no-admins` 让它们保持普通用户，
订阅过滤策略只按 `userId` 匹配。

```bash {runsOn=workstation}
npm run exp:login -w @cloudalbum/experiments
npx tsx experiments/notification/seed-users.ts --count 2 --email {{ learner.inputs.notify-email }} --no-admins
```

清单写在工作台的 `.cloudalbum/experiments/notification-users.json`（0600，含这两个测试账号的密码，只用于本实验）。

再看起点的能力状态：

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules | {notification: .notification.driver, email: .email.driver}'
```

:::why
**为什么要在第一步就建好用户？** 种子脚本靠 outbox 里的验证码完成邮箱验证；切到 SES 之后验证邮件会真正发出，而沙盒期 SES 只能发给已验证的地址。
先在 outbox 档把用户准备好，后面的对比实验前后用的是同一批人。
:::

:::expected
脚本为每个用户打印一行 `u1  you+u1@…  member  photo=…  邮件通知=on（db）`；notification 的驱动是 `db`，email 的驱动是 `outbox`。
:::

::checks
