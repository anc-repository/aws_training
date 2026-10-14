---
step: register-latency
---

With auth=local, sign-up calls EmailPort directly inside the request: in the outbox tier that is one file write (milliseconds); in the SES tier it is one HTTPS API call (tens to a hundred-odd milliseconds).
The runner signs up 10 users `success+reg-<runId>-<n>@simulator.amazonses.com` and records the sign-up API's latency and the `email` segment of Server-Timing:

```bash {runsOn=workstation}
npm run exp -- email --label after --scenario register-latency --upload
npm run exp:report -- email --experiment register-latency
```

::experiment{module=email id=register-latency label=after}

:::expected
The after `emailMsP50` is clearly higher than the before you ran on the side in step 1 (if you did), and the sign-up API's p95 slows down accordingly.
Once sending goes through a queue (the `email.send` task with `QUEUE_DRIVER=sqs`), users no longer feel this delay.
:::

::checks
