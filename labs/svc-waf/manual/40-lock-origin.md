---
step: lock-origin
---

锁定源站：只允许 CloudFront 回源，直连入口只对你的工作台开放。之后 WAF 就无法被绕过。

:::tip
用 `--set`（写入 cdn 的 `ownsEnv` 键），不是 `--param`。锁定后平台 Lambda 访问不到实验机的公网入口，后续的直连类检查改从实验机 / 工作台发起。
:::

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR={{ workstation.publicIp }}/32 --dry-run
```

确认后执行（cdn 栈更新安全组与直连策略，分配重新部署，通常几分钟）：

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR={{ workstation.publicIp }}/32
```
:::

:::expected
`waf` 变为 `ok`（DEP-018 消失）；下一步的 `bypass` after 会显示直连不可达。
:::
