---
step: domain
---

在变量面板确认你填写的域名 `{{ learner.inputs.domain }}`。如果本账号已经有它（或其父域）的公有托管区域，把托管区域 ID 也填上，
下一步就不需要等待委派。

先看一下这个名字现在解析到哪里（没有记录时返回空）：

```bash {runsOn=workstation}
dig +short {{ learner.inputs.domain }} @8.8.8.8
dig +short NS {{ learner.inputs.domain }} @8.8.8.8
```

:::tip
CloudShell 或工作台没有 `dig` 时先执行 `sudo dnf install -y bind-utils`。`@8.8.8.8` 让查询绕过本机缓存，直接看公共解析器的回答。
:::

:::expected
还没有启用 dns 时，第一条命令通常返回空（或者返回你在其他地方设置的旧记录）；第二条返回这个名字当前的名称服务器——
已有 Route 53 托管区域时是 4 个 `awsdns` 名称服务器。
:::

:::why
**为什么推荐子域？** 只托管 `lab.example.com` 这样的子域，主域名的其他记录（网站、邮件）不受影响；父域只需要加 4 条 NS 记录。
托管整个 `example.com` 则要在注册商处改掉全部 NS，影响面大得多。
:::

::checks
