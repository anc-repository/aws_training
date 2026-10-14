---
step: orient
---

Start with the local list. Open `/lab` in the App preview on the right: the left of the top bar says "当前按小时计费的资源：EC2 实例 ×1、公网 IPv4 ×1（已启用 … 小时）；
未填写 cost-rates.yaml，不显示金额" (hourly-billed resources now: EC2 instance ×1, public IPv4 ×1 (on for … hours); cost-rates.yaml not filled in, so no amounts are shown). You can also look directly on the lab instance:

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.cost | {driver, status, localHealth, detail}'
```

:::expected
`driver` is `local` and `status` is `off`; detail lists the EC2 instance and the public IPv4 address. The workbench and platform resources are **not** in the list — they are not modules this project enabled through
scripts/module.
:::

:::saa{domain=cost confusable="按小时计费 vs 按用量计费"}
Public IPv4, NAT Gateway, interface endpoints, RDS and ElastiCache nodes are all billed by the hour for as long as they exist; data transfer out and request counts are billed by usage, which the local list can only describe as "本机无法估算" (cannot be estimated on this host).
:::

::checks
