---
step: ip-after
---

再做一次同样的换 IP 演练。这次脚本在关联临时 EIP 之后把记录 UPSERT 到新地址，然后持续用公共解析器查询并访问域名链接：

```bash {runsOn=workstation}
npm run exp -- dns --label after --scenario ip-change-drill --fault-via local --param env={{ session.env }} --upload
```

::experiment{module=dns id=ip-change-drill label=after}

:::expected
旧 IP 链接照样失败（`oldLinkFailures` > 0），但域名链接在 TTL 量级的时间内恢复：`resolverSwitchSec`、`domainRecoverySec`
在一两分钟之内；报告中 before 与 after 标注为可比的一对。结束时记录改回 `{{ target.publicIp }}`，临时 EIP 已释放。
:::

:::saa{domain=resilient}
DNS 切换不是瞬间完成的：解析器按 TTL 缓存答案，部分客户端缓存得更久。迁移前先把 TTL 调低、等旧 TTL 过期再切换；
需要秒级切换时，在 ALB / CloudFront 层做（Alias 到它们，目标变化不需要改 DNS）。
:::

::checks
