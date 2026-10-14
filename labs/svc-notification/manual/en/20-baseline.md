---
step: baseline
---

Record before: the runner, as an admin, posts 20 comments at random on the three test users' photos, each producing one `comment.created` event;
then it reads the delivery records of these events from the server (`GET /api/admin/notifications/deliveries`).

```bash {runsOn=workstation}
npm run exp -- notification --label before --scenario fanout --upload
```

::experiment{module=notification id=fanout label=before}

Open the app's `/admin/outbox`: every comment added one notification email written to the outbox (in this card's start state, email is the outbox and nothing is actually sent).

:::expected
`deliveriesByChannel` in the report only has `email`, one row per event; the `notification` segment of the comment requests' Server-Timing includes EmailPort's time
(the `email` segment).
:::

:::tip
The db driver's time grows linearly with the number of recipients: one "admin broadcast" is sent to every admin one by one. When the feature comparison endpoint `/api/lab/notification/compare`
is available, the report also shows `broadcast_db_email_calls` (= the number of admins).
:::

::checks
