---
section: overview
---

## Background

When "someone commented on your photo", CloudAlbum first writes an in-app message (the unread count on the bell) and then sends the off-site notification. In the start state, the db driver has EC2 itself call
EmailPort once per recipient: the more recipients and channels, the more work EC2 does, and with QUEUE_DRIVER=sync all of that time counts toward the comment request.
This card hands off-site fan-out to Amazon SNS: the app calls `Publish` once with message attributes such as `userId` and `audience`, and the filter policies on the subscriptions decide who receives it;
the module's own SQS inbox queue gets a copy of every event, and the worker records deliveries from it.

:::why
SNS is push-based publish/subscribe: one message fans out into several deliveries, one per subscription. SQS is a pull-based queue: each message goes to only one consumer.
"An SNS topic + one SQS queue per consumer" combines the two: every downstream system has its own copy and buffer, so one being temporarily unavailable neither loses messages nor slows down the others.
:::

## Comparison experiments

### Off-site fan-out of one event (notification/fanout, required)

- **Without SNS (db driver)**: for every comment event, EC2 calls EmailPort to write one email to the recipient (in this card's start state it goes to the local outbox).
- **With SNS**: the same comments, but EC2 only calls Publish once (on the order of ten to a few dozen milliseconds); SNS sends the email, and the inbox queue receives a separate copy.
- **Where you see it**: the channels in the report's server-side delivery records change from `email` to `sns` + `sqs-copy`; the response header `X-CloudAlbum-Path` changes from
  `notification=db:email` to `notification=sns:published`; your mailbox receives plain-text emails from AWS Notifications with an unsubscribe link.
- **If the results are not what you expect**: first confirm that the seeded users' subscriptions are all confirmed (PendingConfirmation subscriptions get no deliveries); then confirm that the worker is running (it writes `sqs-copy`).

### Subscription filter policies (notification/filter, required)

Send one event to `+u1` only: only the email addressed to `+u1` arrives (all aliases land in the same mailbox, so tell them apart by recipient address), and CloudWatch's
`NumberOfNotificationsFilteredOut` goes up.

## Before you start

- You need a mailbox that receives mail and supports `+` aliases (the "notification email" you entered before starting). During the card you click about four
  "AWS Notification - Subscription Confirmation" emails: one for the operations subscription (`+admin`) and three for the test users (`+u1` to `+u3`). Confirmation emails often end up in the spam folder.
- The platform does not confirm subscriptions for you (manual prerequisite confirm-email).

## Platform mode notes

The comparison experiments run on the workbench; stopping and starting the worker happens in the lab terminal (the platform management channel is SSM, so no SSH is needed).
