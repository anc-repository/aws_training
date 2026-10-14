---
step: after
---

记录 after：与 before 相同的故障与负载，这次两条查询在本地与 CloudWatch 两侧并排执行。

```bash {runsOn=workstation}
npm run exp -- logging --label after --scenario query-compare --upload
```

::experiment{module=logging id=query-compare label=after}

:::expected
`agreeLocal` 与 `agreeCloudwatch` 都为真：本地扫描、CloudWatch 的 Insights 与客户端看到的 503 个数一致。报告给出两侧的用时；
Insights 另给出扫描字节。单实例、数据量小时本地扫描往往更快——CloudWatch 赢在跨实例、实例没了仍可查与聚合能力，而不是这一次的速度。
:::

:::tip
`npm run exp:report -- logging --experiment query-compare` 生成 before 对 after 的报告。
:::

::checks
