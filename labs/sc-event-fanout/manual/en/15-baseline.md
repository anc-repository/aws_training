---
step: baseline
---

Record **before**: the runner, as an admin, posts 20 comments at random on the two test users' photos, each producing one `comment.created` event;
then it reads the delivery records of these events from the server (`GET /api/admin/notifications/deliveries`).

```bash {runsOn=workstation}
npm run exp -- notification --label before --scenario fanout --upload
```

::experiment{module=notification id=fanout label=before}

Open `/admin/outbox` as an admin in the App preview: every comment added one notification email written to the outbox, and the top of the page says “邮件未真正发出（本地 outbox）” (emails not actually sent — local outbox).

:::expected
`deliveriesByChannel` in the report only has `email`, one row per event; the `notification` segment of the comment requests' Server-Timing includes EmailPort's time.
The two users' real mailboxes are empty.
:::

:::why
The db driver's time grows linearly with the number of recipients: when a popular photo has dozens of followers, posting a comment waits for dozens of email calls (all of it inside the request with `QUEUE_DRIVER=sync`).
:::

::checks
