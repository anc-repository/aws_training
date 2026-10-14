---
step: ingest
---

记录 after：发 20 个请求，然后每 2 秒查一次 CloudWatch，直到它们全部出现。

```bash {runsOn=workstation}
npm run exp -- logging --label after --scenario ingest-lag --upload
```

::experiment{module=logging id=ingest-lag label=after}

:::expected
`local.foundImmediately` 等于请求数（本地立即可见）；`ingestLagP50Ms` 是 CloudWatch 一侧的摄取延迟（`ingestionTime − timestamp`），
秒级到十几秒；`missing` 为 0。
:::

:::why
摄取延迟由两段组成：发送器的批量间隔（`LOG_CW_FLUSH_MS`，默认 2 秒；agent 方式约 5 秒）与 CloudWatch 的摄取。事件时间取 Nginx 行的
`ts`（秒级精度），所以单个值有 1 秒以内的误差。
:::

::checks
