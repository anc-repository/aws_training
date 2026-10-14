---
step: enable
---

把 AWS WAF 挂到 CloudFront 上，先用 **Count** 模式观察（托管规则组只计数、先不拦）。

:::why
新启用托管规则组时先 Count、读几分钟真实流量里的 COUNT 记录、确认没有误杀，再改 Block——否则很容易误杀真实用户（例如照片上传）。
:::

:::method{kind=script default}
```bash {runsOn=workstation}
scripts/module enable waf --dry-run
```

确认后执行（会在 us-east-1 部署 Web ACL，再把 `WebAclArn` 注入 cdn 栈，分配重新部署，通常几分钟）：

```bash {runsOn=workstation}
scripts/module enable waf
```
:::

启用脚本还会把实例上的 `denylist.conf` 首次全量导入 IP 集合 `cloudalbum-blocklist`（us-east-1）。此刻源站仍未锁定，`waf` 会因 **DEP-018** 显示 `degraded`——这在本卡属于预期，下一步修好。
