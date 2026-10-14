---
step: insights
---

再制造一点 5xx，然后在控制台用 Logs Insights 统计，并找到指标过滤器生成的指标。

1. 在工作台再跑一次 before 用过的负载（不上传，只为制造 5xx；故障 120 秒后自动解除）：

```bash {runsOn=workstation}
npm run exp -- logging --label after --scenario query-compare
```

:::method{kind=console default}
2. CloudWatch → **Logs Insights** → “查询”下拉框选择保存的查询 `cloudalbum-{{ session.env }}/5xx-by-route`（日志组
   `/cloudalbum/{{ session.env }}/nginx`），时间范围选“过去 1 小时”，运行。看结果面板下方的统计：匹配的记录数、扫描的记录数与扫描的字节数。
3. CloudWatch → **指标** → 所有指标 → 命名空间 `CloudAlbum/Logs` → 找到 `Nginx5xx`，用“总和”、周期 1 分钟画出来。
:::

:::wait{typical=5 max=10}
指标过滤器在摄取时匹配：第一次匹配到 status ≥ 500 的行之后，指标才出现在列表中，通常要等几分钟。
:::

:::expected
`/api/lab/now` 的 errors 与报告中的 5xx 条数一致；`Nginx5xx` 指标有数据点。
:::

:::saa{domain=resilient confusable="指标过滤器 vs Logs Insights"}
指标过滤器只对**创建之后**摄取的日志生效，不回溯；要统计历史数据用 Logs Insights（按扫描量计费）。
指标过滤器生成的指标可以直接接告警（svc-monitoring）。
:::

::checks
