---
step: register-latency
---

auth=local 的注册在请求内直接调用 EmailPort：outbox 档是一次写文件（毫秒级），SES 档是一次 HTTPS API 调用（几十到上百毫秒量级）。
运行器注册 10 个 `success+reg-<runId>-<n>@simulator.amazonses.com` 用户，记录注册接口的延迟与 Server-Timing 的 `email` 段：

```bash {runsOn=workstation}
npm run exp -- email --label after --scenario register-latency --upload
npm run exp:report -- email --experiment register-latency
```

::experiment{module=email id=register-latency label=after}

:::expected
after 的 `emailMsP50` 明显高于第 1 步顺手跑的 before（如果跑了）；注册接口的 p95 相应变慢。
把发信放进队列（`QUEUE_DRIVER=sqs` 的 `email.send` 任务）后，用户就感觉不到这段延迟。
:::

::checks
