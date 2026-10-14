---
step: wire
---

启用 shell-access。脚本按“防锁死”的顺序执行：部署策略与会话日志组 → **先**附加策略、确认 Agent `Online` 并用 Run Command 做冒烟
→ 备份并写入会话首选项（runAs `cloudalbum-ops`、日志写入 `/cloudalbum/{{ session.env }}/ssm-sessions`）→ 最后把基础栈参数
`SshIngressCidr` 置空，删除 22 端口规则；投递时在实验机上创建 `cloudalbum-ops` 与受限 sudoers。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable shell-access --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable shell-access
```
:::

:::wait{typical=3 max=10}
任一检查不通过（Agent 不在线、冒烟失败），脚本以退出码 5 中止，22 端口保持不变。
:::

::console-link[在 EC2 控制台打开实验机的安全组]{link=ec2.securityGroup sgId="{{ target.sgId }}"}

:::expected
shell-access 的驱动为 `ssm`、状态正常，detail 写着“Agent Online（版本 …） · 无管理端口入站 · 会话日志 → /cloudalbum/{{ session.env }}/ssm-sessions”；
安全组里不再有 22 端口规则。
:::

:::saa{domain=secure confusable="AmazonSSMManagedInstanceCore vs 最小权限"}
`AmazonSSMManagedInstanceCore` 省事，但它还授予了读取**所有** Parameter Store 参数的权限。本模块的策略只含会话与 Run Command
需要的部分、写会话日志与感知器的只读调用；`--param ManagedCore=true` 保留托管策略作为对照。
:::

::checks
