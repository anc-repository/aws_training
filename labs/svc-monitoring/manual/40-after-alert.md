---
step: after-alert
---

记录 after：同样的合成 5xx 负载，这次本地评估器与 CloudWatch 告警并排计时，直到两边都进入 ALARM。

```bash {runsOn=workstation}
npm run exp -- monitoring --label after --scenario time-to-alert --upload
```

::experiment{module=monitoring id=time-to-alert label=after}

:::expected
`biz.local_detect_sec` 与 before 相近（本地一侧照常运行）；`biz.cw_alarm` 为 1，`biz.cw_detect_sec` 是分钟级。
邮箱随后收到主题含 `ALARM: "cloudalbum-{{ session.env }}-app-5xx-rate"` 的邮件。
:::

:::saa{domain=resilient confusable="周期 × 评估期 vs 出现延迟"}
告警延迟 ≈ 周期 × M of N 中的数据点数 + 指标出现延迟。缩短周期（高分辨率指标）能更快，但费用更高。
:::

::checks
