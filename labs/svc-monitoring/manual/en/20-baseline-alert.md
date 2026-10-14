---
step: baseline-alert
---

Record before: send 5 requests per second to a **synthetic 5xx endpoint** (half of the requests return 503) until the local evaluator sets `app-5xx-rate` to ALARM.

```bash {runsOn=workstation}
npm run exp -- monitoring --label before --scenario time-to-alert --upload
```

::experiment{module=monitoring id=time-to-alert label=before}

:::expected
`biz.local_alarm` is 1 and `biz.local_detect_sec` is on the order of tens of seconds (30-second evaluation interval, 5-minute window). The admin in-app messages and `/admin/outbox` each have one alarm.
:::

:::why
**Why a synthetic endpoint rather than the shared error5xx fault?** error5xx affects every request, including the lab instance's health check on `/api/health/live` every 30 seconds —
a failing health check restarts the api, and the fault disappears with the process. The synthetic endpoint only affects the requests sent to it, so the local evaluator and CloudWatch see the same 5xx.
:::

::checks
