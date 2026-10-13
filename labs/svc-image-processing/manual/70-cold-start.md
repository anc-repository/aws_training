---
step: cold-start
---

（选做）冷启动：让函数闲置 15 分钟，上传 1 张照片，再连续上传 5 张，然后用 CloudWatch Logs Insights 统计 `Init Duration`。
剩余时间不足 30 分钟时跳过本步骤。

```bash {runsOn=workstation}
aws logs start-query --log-group-name "{{ var.logGroup }}" --start-time $(( $(date +%s) - 3600 )) --end-time $(date +%s) --query-string 'filter @type = "REPORT" | stats count(@initDuration) as coldStarts, avg(@initDuration) as avgInit, pct(@duration, 95) as p95 by bin(5m)'
```

用返回的 `queryId` 读取结果：

```bash {runsOn=workstation}
aws logs get-query-results --query-id <上一条命令返回的 queryId>
```

:::tip
想对照预置并发：发布一个版本并配置 1 个预置并发，重复上面的测量后**立即删除**。预置并发按时长计费，开着就会产生费用。
:::

:::expected
闲置后的第一张有 `Init Duration`（数百毫秒量级）；紧接着串行上传的照片复用执行环境，没有 `Init Duration`。
:::

::checks
