---
section: wrap-up
---

## What you did

- Made transactional email really go out through SES: the verification code reached your inbox, and when the sandbox rejected an unverified address, the app honestly recorded a failure.
- Built the return path for bounces and complaints: configuration set event destination → SNS → SQS feedback queue → worker, with no inbound port open on the lab instance.
- Handed the off-site fan-out of "new comment" to SNS: publish once, deliver to the matching user's email subscription through a `userId` filter policy, and copy to the inbox queue; messages wait in the queue while the worker is down.

## Overall comparison

| Measure | At the start | When done |
|---|---|---|
| How one event is delivered | EC2 calls EmailPort one by one | Publish once, SNS delivers |
| Publisher time vs number of people | Grows linearly | Stays about the same |
| Do users receive email | No (outbox only) | Yes (in the sandbox, only verified addresses and the mailbox simulator) |
| Who decides "who should receive it" | App code | Subscription filter policies (on the SNS side) |
| Adding channels | Change app code | Add a subscription (SQS, Lambda, HTTPS, SMS and more) |
| Inbound ports EC2 needs | None | None (SNS → SQS and SES → SNS → SQS are both pulled by the worker) |
| Bounces and complaints | Do not exist | Events flow back, and non-essential email to invalid addresses stops automatically |

## Exam points recap

- SNS topics, subscription protocols, subscription filter policies (message attributes / message body), email subscription confirmation, raw message delivery and subscription-level DLQs; SNS FIFO + SQS FIFO for ordered fan-out.
- SNS + SQS fan-out versus SQS competing consumers; queues buffer messages while consumers are down; `aws:SourceArn` in queue policies.
- SES identity verification (email address / domain), DKIM, SPF and DMARC; the sandbox and production access (per Region); sending quotas and rates.
- SES configuration sets and event destinations; using SNS + SQS to safely deliver AWS services' asynchronous events to an app with no inbound ports.
- When to use SNS, SES and EventBridge; EC2 restricts outbound port 25 by default.
