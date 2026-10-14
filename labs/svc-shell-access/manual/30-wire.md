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
需要的部分、写会话日志、感知器的只读调用，以及只读 `/cloudalbum/{{ session.env }}/handoff/*` 下的一次性交接参数（`scripts/module`
经 SSM 投递机密时用 SecureString 交接，用完即删）；`--param ManagedCore=true` 保留托管策略作为对照。
:::

:::tip
独立模式（自己的账号、不经平台）下，启用本模块后 `scripts/module` 的投递通道变为 SSM：机密只经 SecureString 交接参数**写入**
`secrets.env`，从不读回（Run Command 的输出会留在命令历史里）。之后再启用需要沿用已有机密的模块（cdn 的 `ORIGIN_VERIFY`、
database 的 `DB_PASSWORD`、image-processing 的 `CALLBACK_HMAC_KEY`）会以 `SECRETS_READBACK_OVER_SSM` 中止并给出办法：
先启用那些模块再启用 shell-access；或启用时加 `--param KeepSsh=true` 保留 22 端口，对那些命令加 `--delivery ssh`；
或先 `scripts/module disable shell-access --reopen-ssh`。
:::

::checks
