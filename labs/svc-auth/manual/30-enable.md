---
step: enable
---

启用 Cognito：模块部署 User Pool（`Retain` + 删除保护、用户名为邮箱、密码策略、可选 TOTP）、公有应用客户端 `cloudalbum-spa`
与用户组 admin / member，再在只读窗口内把本地账号 bulk 迁移进 User Pool（`AdminCreateUser` + `MessageAction=SUPPRESS`，不发邀请），
写入 `auth.env` 并重启。最后在工作台以你的身份执行钩子 `cognito-passwords`，给测试账号设置已知密码。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable auth --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable auth
```
:::

:::wait{typical=4 max=15}
部署、迁移与重启。迁移期间应用可以浏览、不能注册或登录。
:::

如果输出提示钩子没有执行（例如命令中途被中断），可以单独再执行一次（幂等）：

```bash {runsOn=workstation}
scripts/module hooks run --pending
```

:::expected
auth 的状态为“降级”，原因只有 DEP-013（Cognito 自己发验证码，本地 outbox 看不到）；页面上的登录徽章显示“登录由 Amazon Cognito 提供”。
:::

::checks
