---
step: baseline-alert
---

记录 before：以每秒 5 个请求打一个**合成 5xx 端点**（一半请求返回 503），直到本地评估器把 `app-5xx-rate` 置为 ALARM。

```bash {runsOn=workstation}
npm run exp -- monitoring --label before --scenario time-to-alert --upload
```

::experiment{module=monitoring id=time-to-alert label=before}

:::expected
`biz.local_alarm` 为 1，`biz.local_detect_sec` 在几十秒的量级（评估间隔 30 秒、窗口 5 分钟）。管理员站内信与 `/admin/outbox` 里各有一封告警。
:::

:::why
**为什么用合成端点而不是共享的 error5xx 故障？** error5xx 作用于全部请求，包括实验机健康检查每 30 秒一次的 `/api/health/live`——
健康检查失败会重启 api，故障随进程消失。合成端点只影响打到它的请求，本地评估器与 CloudWatch 看到的是同一批 5xx。
:::

::checks
