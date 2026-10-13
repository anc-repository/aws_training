---
step: signup
---

在应用预览里用**你自己的邮箱**注册一个新账号。注册表单由前端的 Amplify 直接提交给 User Pool，EC2 不经手密码。

1. 打开预览，选择“注册”，填写邮箱与密码（至少 10 位，包含大小写字母与数字）。
2. 去邮箱查收 Cognito 发来的验证码（发件人是 Cognito 的默认地址），在页面上完成验证并登录。
3. 打开“我的邮件”（`/me/outbox`）：这次的验证邮件不在这里。

:::expected
验证码邮件出现在你的邮箱里，本地 outbox 没有；`/api/capabilities` 的 auth 状态为 degraded，原因是 DEP-013。
:::

:::warning
不要用别人的邮箱注册：Cognito 发出的邮件无法撤回。默认发件的每日额度很低，收不到时稍后再试。
:::

::checks
