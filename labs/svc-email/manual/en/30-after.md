---
step: after
---

Record the after: the same four addresses, this time sent through SES; the runner polls `/api/admin/outbox` until each email's delivery status has been updated by a feedback event (up to 3 minutes).

```bash {runsOn=workstation}
npm run exp -- email --label after --scenario send-matrix --param to={{ learner.inputs.ses-identity }} --upload
npm run exp:report -- email
```

::experiment{module=email id=send-matrix label=after}

Open the app's `/admin/outbox`: every row shows the transport, the SES MessageId and a delivery status badge ("已投递 / 退信 / 投诉", i.e. delivered / bounced / complained).
The `email_status` of the user for `bounce@simulator.amazonses.com` is now `bounced`: from now on it only gets the two essential kinds of email, verification and password reset.

:::why
**Why handle bounces and complaints?** If the bounce or complaint rate is too high, the account is reviewed and sending may even be paused (see the official docs for the thresholds). Feedback events flow back through
configuration set → SNS → SQS, and the app pulls them, so no inbound port is needed; the configuration-set-level and account-level suppression lists are a second line of protection.
:::

:::expected
before is `outbox / none` everywhere; in after, success → `delivered`, bounce → `bounced`, complaint → `complained`, and your mailbox receives the "reset password" email;
the feedback DLQ is at 0.
:::

:::tip
Feature comparison (further reading): `npm run exp -- email --label after --scenario compare --param to={{ learner.inputs.ses-identity }}` calls
`POST /api/lab/email/compare`, which sends the same email once through the outbox and once through SES and shows the timings side by side (the endpoint is registered in the integration phase; skip it if it returns 404).
:::

::checks
