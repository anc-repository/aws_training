---
step: after
---

Record **after**: the same 20 comments as step 2, but this time each event has only one `Publish`.

```bash {runsOn=workstation}
npm run exp -- notification --label after --scenario fanout --upload
npm run exp:report -- notification
```

::experiment{module=notification id=fanout label=after}

:::expected
The delivery channel for before is `email` and for after `sns` + `sqs-copy` (one row each per event); after's `notification` segment is the time of one Publish, independent of the number of subscribers.
The notification emails in your mailbox come from AWS Notifications as plain text with an unsubscribe link at the bottom.
:::

:::tip
Feature comparison (further reading, not uploaded): `npm run exp -- notification --label after --scenario compare` calls `POST /api/lab/notification/compare`,
which sends the same test event once through the db driver and once through the sns driver and shows their times and call counts side by side (the endpoint is registered during integration; skip it if it returns 404).
:::

:::why
**SNS + SQS fan-out vs one SQS queue.** One queue means competing consumers: when three downstream systems consume the same queue, each message is processed by only one of them.
With an SNS topic + one SQS queue per downstream system, each has its own copy and buffer, so one being temporarily unavailable neither loses messages nor slows down the others.
:::

::checks
