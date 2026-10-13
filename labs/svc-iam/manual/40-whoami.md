---
step: whoami
---

记录 after：同样的身份对照，这次应用使用实例角色。

```bash {runsOn=workstation}
npm run exp -- iam --label after --scenario whoami --upload
```

::experiment{module=iam id=whoami label=after}

:::expected
调用者是 `arn:aws:sts::<账号>:assumed-role/CloudAlbumAppRole/<实例 ID>`；密钥前缀 `ASIA`；距离过期还有几小时；磁盘上的长期密钥数为 0。
:::

:::why
**临时凭证为什么更安全？** 它有过期时间，EC2 在过期前自动轮换，SDK 自动刷新；它只存在于 IMDS 与进程内存里，不会进入快照与备份。
怀疑泄露时，可以对角色“撤销活动会话”（按 `aws:TokenIssueTime` 拒绝旧会话），不必删除角色。
:::

::checks
