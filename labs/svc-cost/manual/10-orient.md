---
step: orient
---

先看本地清单。在右侧“应用预览”打开 `/lab`：顶栏左侧写着“当前按小时计费的资源：EC2 实例 ×1、公网 IPv4 ×1（已启用 … 小时）；
未填写 cost-rates.yaml，不显示金额”。也可以在实验机上直接看：

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.cost | {driver, status, localHealth, detail}'
```

:::expected
`driver` 为 `local`、`status` 为 `off`；detail 列出 EC2 实例与公网 IPv4。清单里**没有**工作台与平台资源——它们不是本项目经
scripts/module 启用的模块。
:::

:::saa{domain=cost confusable="按小时计费 vs 按用量计费"}
公网 IPv4、NAT Gateway、Interface Endpoint、RDS、ElastiCache 节点都是“开着就按小时计费”；数据传出、请求数是按用量计费，本地清单只能写“本机无法估算”。
:::

::checks
