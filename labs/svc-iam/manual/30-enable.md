---
step: enable
---

启用实例角色：模块部署一条只读策略 `cloudalbum-{{ session.env }}-iam`，附加到 `CloudAlbumAppRole`，写入 `IAM_CREDENTIALS=role` 并重启应用。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable iam --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable iam
```
:::

:::wait{typical=2 max=10}
部署策略栈、附加策略并重启。IAM 的变更是最终一致的，探针可能要等几秒才看到新权限。
:::

:::expected
iam 的状态为“正常”，detail 显示 `assumed-role/CloudAlbumAppRole/<实例 ID>` 与 `ASIA` 前缀；角色的权限列表多了 `cloudalbum-{{ session.env }}-iam`。
:::

:::saa{domain=secure confusable="GetCallerIdentity vs 授权"}
`sts:GetCallerIdentity` 不需要任何权限，显式 Deny 也挡不住：它只能证明“认证成功、我是谁”，不能证明“我有权限”。
所以模块的健康检查还要加一个受策略约束的调用（`iam:GetRole`）。
:::

::checks
