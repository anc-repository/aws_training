---
section: overview
---

## Background

The starting point is L0: when someone comments on a photo, CloudAlbum writes an in-app message (the unread count on the bell), then EC2 calls EmailPort one by one to email everyone who turned on email notifications —
but EmailPort only writes emails to the local outbox (you can preview them at `/me/outbox`, where the page says “本地实现，未真正发信”, local implementation, not actually sent). The more recipients and channels, the more work EC2 does,
yet users never receive a single email; bounces and complaints do not even exist.

This card first makes transactional email really go out through **Amazon SES**, pulling bounces and complaints back into the app through SNS → SQS; then it hands the off-site fan-out of "new comment" to **Amazon SNS**:
the app calls `Publish` once with a `userId` message attribute, and subscription filter policies decide who receives it; the module's own SQS inbox queue gets a copy of every event, from which the worker fills in its records.

## Architecture

### At the start

![At the start: the api calls EmailPort one by one, and emails are only written to the local outbox](assets/arch-start.svg)

### When done

![When done: the api publishes once to the SNS notification topic, which filters by userId and delivers to the user's mailbox and copies to the SQS inbox queue; verification codes go out through SES, and bounces and complaints come back to the worker through SNS → SQS](assets/arch-end.svg)

## Why combine them

- **SNS handles "publish once, deliver to many"**: every subscription gets its own copy, so the publisher's time stays the same as recipients grow; subscription filter policies run before delivery,
  so each subscription only receives messages relevant to it; adding SMS, mobile push or analytics later is just another subscription.
- **SQS turns push into reliable pull**: an SNS → SQS subscription puts events into a queue that the worker long-polls, so the lab instance needs no inbound port at all; while the worker is down, messages wait in the queue.
  The queues here are **built into** the notification and email modules; the queue module is not enabled.
- **SES handles transactional email**: personalized emails that must prove mailbox ownership, such as verification codes and password resets, go out through SES from your sender identity (with a DKIM signature);
  the configuration set's event destination sends delivery, bounce and complaint events to SNS and on into the SQS feedback queue, where the worker updates delivery status and stops non-essential email to bouncing addresses.
- **Common wrong combinations**: sending verification codes through SNS email subscriptions (the same plain text to every subscriber, with an unsubscribe footer, and recipients must confirm first); using one SQS queue for "one-to-many"
  (competing consumers, each message to only one consumer); running SMTP on EC2 to send directly (outbound port 25 is restricted by default and there is no sender reputation); having SES push events to an HTTPS endpoint on the instance
  (an inbound port must be exposed); ignoring the sandbox (while in it you can only send to verified addresses and the mailbox simulator).

## Comparison experiments

### Off-site fan-out of one event (notification/fanout, required)

- **At the start (db)**: for every comment event EC2 calls EmailPort one by one (writing to the outbox at this card's starting point), and the `notification` segment of the comment request's Server-Timing includes those calls.
- **When done (sns)**: the same comments, but EC2 calls `Publish` only once; SNS sends the email, and the inbox queue receives a separate copy.
- **Where you see it**: the channels in the report's server-side delivery records change from `email` to `sns` + `sqs-copy`; the path header changes from `notification=db:email` to `notification=sns:published`.

### Subscription filtering (notification/filter, required)

Post one comment on a `+u1` photo only: the server has just one `sns` row and one `sqs-copy` row, only the email to `+u1` arrives in the mailbox,
and CloudWatch's `NumberOfNotificationsFilteredOut` goes up.

### Worker outage (notification/worker-stop, required)

The runner stops the worker at 5 s and starts it at 50 s: comments still succeed and notification emails still arrive; only the inbox queue backs up, and once the worker recovers the backlog is consumed and the `sqs-copy` records fill in.

### SES sandbox (email/sandbox, required)

Send to an address that has not been verified: the server records `failed` with the error `MessageRejected` and the path segment `email=ses:rejected`; the sign-up itself completes as usual,
and the app never quietly rewrites a failed email as "sent".

## Before you start

- **SES sender identity** (`ses-identity`): an email address you can receive mail at. After the deployment in step 3, click the link in "Amazon Web Services – Email Address Verification Request" in that mailbox.
- **Notification email** (`notify-email`): a mailbox that supports `+` aliases; it can be the same as the sender identity. The two test users are its `+u1` and `+u2` aliases, and the operations subscription uses the `+admin` alias;
  this card has you click about three "AWS Notification - Subscription Confirmation" emails, which often end up in spam.
- The card is completed entirely in the SES sandbox without requesting production access; the platform never clicks any verification or confirmation link for you.

## Platform mode notes

The comparison experiments and seed scripts run on the workbench; stopping and starting the worker goes through the platform management channel (SSM), with no SSH needed.
