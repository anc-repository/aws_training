---
step: enable
---

Wire in SNS. The module creates the topic `notification-events`, the inbox queue `notification-inbox` (raw message delivery, no filter policy), the subscription-level DLQ
`notification-dlq`, and an email subscription for the operations fallback mailbox (filter policy `{"audience":["admin"]}`). Use your mailbox's `+admin` alias as the operations mailbox:
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

`--no-migrate`: for users who already turned on email notifications, the next step creates subscriptions one by one with `subscribe-users.ts` (through the same `subscribeEmail` as the migration script).

:::wait{typical=4 max=20}
Deploying the topic and the two queues usually takes a minute or two. Then find "AWS Notification - Subscription Confirmation" in the operations mailbox and click **Confirm subscription**.
Until you confirm, notification's status is a yellow "运维订阅待确认" (operations subscription pending confirmation) — an expected wait, not a failure.
:::

Once confirmed, post a comment on a `+u1` photo in the App preview, then look at that request's response headers:

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.notification | {driver, status, detail}'
```

:::why
**Why do email subscriptions need confirmation?** Anyone could subscribe someone else's address to their own topic; SNS only starts delivering after the recipient clicks the confirmation link.
This is also one reason SNS is a poor fit for transactional email such as sign-up verification codes (the sender is AWS Notifications, it is plain text only, and every email carries an unsubscribe footer).
:::

::console-link[Open the inbox queue in the SQS console]{link=sqs.queue queueUrlEncoded="{{ var.inboxUrl | url }}"}

:::expected
notification is Healthy, with a detail like `主题 cloudalbum-…-notification-events · 已确认订阅 2 · 待确认 0 · 收件队列 0 · 订阅级 DLQ 0` (topic, confirmed subscriptions, pending, inbox queue, subscription DLQ);
the comment request's path header contains `notification=sns:published`; the inbox queue's access policy only allows this topic (`aws:SourceArn`) to send as `sns.amazonaws.com`.
:::

:::saa{domain=secure confusable="主题策略 vs 队列策略"}
When SNS delivers to SQS, the **queue policy** grants write access to `sns.amazonaws.com`, with `aws:SourceArn` limiting it to one topic (preventing the confused deputy problem);
the topic policy decides who may publish to the topic. If the queue is encrypted with a CMK, the key policy must also allow `sns.amazonaws.com`, or deliveries fail silently.
:::

::checks
