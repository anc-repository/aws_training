---
step: enable-notification
---

Wire in SNS. The module creates the topic `notification-events`, the inbox queue `notification-inbox` (raw message delivery, no filter policy), the subscription-level DLQ
`notification-dlq`, and an email subscription for the operations fallback mailbox (filter policy `{"audience":["admin"]}`). Use the `+admin` alias of your notification email as the operations mailbox:
for example, if your notification email is `{{ learner.inputs.notify-email }}`, add `+admin` before the `@`.

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable notification --param AdminEmail=<your +admin alias> --no-migrate --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable notification --param AdminEmail=<your +admin alias> --no-migrate
```
:::

`--no-migrate`: the migration framework is not in place yet; the two test users' subscriptions are created with the script below (through the same `subscribeEmail` as the migration script).
As each user, the script turns "email notifications" on again, which makes the sns driver call `Subscribe`: protocol `email`, filter policy `{"userId":["<that user's ID>"]}`.

```bash {runsOn=workstation}
npx tsx experiments/notification/subscribe-users.ts
```

:::wait{typical=5 max=20}
There are three confirmation emails in total (addressed to `+admin`, `+u1` and `+u2`); click **Confirm subscription** in each one. Until then, notification's status is a yellow
“运维订阅待确认” (operations subscription pending confirmation) — an expected wait, not a failure. The worker syncs subscription status every 5 minutes.
:::

When all are confirmed, post a comment on a `+u1` photo in the App preview, then in the SNS console open the "Subscriptions" page of the topic `cloudalbum-{{ session.env }}-notification-events`,
click the `+u1` subscription and look at its "Subscription filter policy".

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.notification | {driver, status, detail}'
```

::console-link[Open the inbox queue in the SQS console]{link=sqs.queue queueUrlEncoded="{{ var.inboxUrl | url }}"}

:::expected
notification is Healthy; the comment request's path header contains `notification=sns:published`; the topic has the inbox queue's sqs subscription and at least 3 confirmed email subscriptions;
the inbox queue's access policy only allows this topic (`aws:SourceArn`) to send as `sns.amazonaws.com`.
:::

:::why
**Why do email subscriptions need confirmation?** Anyone could subscribe someone else's address to their own topic; SNS only starts delivering after the recipient clicks the confirmation link.
**Filter policies match message attributes by default**: if you forget the `userId` attribute when publishing, no subscription with a filter policy receives it; conversely, an email subscription **without** a filter policy receives every message on the topic —
subscribe a user to the topic but forget the filter policy, and they get comment alerts for everyone. That is a privacy incident.
:::

::checks
