---
step: baseline
---

记录 before：运行器先打开 `error5xx` 故障（约 20% 的请求返回 503，120 秒后自动解除），用恒定负载请求 `/api/lab/now`，然后在
**本地一侧**执行两条查询：“按路由统计 5xx”和“按请求 ID 查找”。

```bash {runsOn=workstation}
npm run exp -- logging --label before --scenario query-compare --upload
```

::experiment{module=logging id=query-compare label=before}

:::expected
报告中 `local.errors` 等于客户端看到的 503 个数（`agreeLocal`），并给出本地扫描的用时与扫描字节；`cloudwatch` 一侧显示为不可用。
:::

:::why
本地查询在实例上倒序扫描当前文件与 `.1`：数据量小时很快，但耗时随文件大小线性增长，而且只看得到本机最近两天。
:::

::checks
