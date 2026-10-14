---
step: failover
---

（选做）把路由策略改为故障转移：PRIMARY = 实验机 EIP + 健康检查（检查 `origin.<域名>/api/health/ready?scope=instance`），
SECONDARY = 与记录同名的 S3 静态网站桶里的维护页。

```bash {runsOn=workstation}
scripts/module enable dns --domain {{ learner.inputs.domain }} --target eip --param RoutingPolicy=failover
```

:::why
S3 网站端点按 Host 头找桶，所以桶名必须与记录名完全相同，而且只支持 HTTP。站点已经强制 HTTPS 时，应改在 CDN 层用 CloudFront 的
源站组做故障转移，而不是 DNS 层。健康检查的指标与告警只在 us-east-1。
:::

运行演练：第 10 秒停止实验机上的 Nginx，结束时恢复。

```bash {runsOn=workstation}
npm run exp -- dns --label after --scenario failover-drill --fault-via ssm --upload
```

::experiment{module=dns id=failover-drill label=after}

:::expected
`marks` 依次出现 `unhealthy`（健康检查变为不健康）、`secondaryAnswer`（公共解析器返回维护页桶的地址）、`maintenanceOk`；
总时间数十秒到数分钟。结束后把路由策略改回 `simple`（`--param RoutingPolicy=simple`）。
:::

::checks
