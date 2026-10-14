---
step: subscribe-users
---

Create email subscriptions for the three test users. As each user, the script turns "email notifications" on again (`PUT /api/notifications/prefs`),
which makes the sns driver call `Subscribe`: protocol `email`, `ReturnSubscriptionArn=true`, and a filter policy matching `userId` (admins also get `audience=admin`);
the subscription ARN and the "pending confirmation" status are written back to `notification_prefs`.

```bash {runsOn=workstation}
npx tsx experiments/notification/subscribe-users.ts
```

:::wait{typical=5 max=20}
Each address receives a confirmation email from AWS (three in total, addressed to `+u1` to `+u3`); click **Confirm subscription** in each one.
The worker syncs the subscription status every 5 minutes, after which the settings page changes from “等待确认（请查收 AWS Notifications 的邮件）” (waiting for confirmation — check for the AWS Notifications email) to “已开启” (on).
:::

In the SNS console, open the "Subscriptions" page of the topic `cloudalbum-{{ session.env }}-notification-events`, click the `+u1` subscription and look at its "Subscription filter policy".

:::why
**Filter policies match message attributes by default.** If you forget the `userId` attribute when publishing, no subscription with a filter policy receives the message; conversely, an email subscription **without** a filter policy
receives every message on the topic — subscribe a user to the topic but forget the filter policy, and they get comment alerts for everyone. That is a privacy incident.
:::

:::expected
The topic has at least 5 subscriptions: the inbox queue (sqs), the operations mailbox and the three user mailboxes; the user subscriptions' filter policy scope is `MessageAttributes`.
:::

::checks
