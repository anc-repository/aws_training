---
section: wrap-up
---

## What you did

- Sent the same MIME for real through SES, so `/me/outbox` no longer stands in for "received the email"; email verification now proves ownership.
- Rehearsed delivery, bounces and complaints with the SES mailbox simulator; the events flowed back through SNS → SQS and automatically stopped non-essential email to the bounced address.
- Looked at the DKIM signature in the raw email and experienced the sandbox limits.

## Exam points recap

- SES identity verification (email address / domain), Easy DKIM, SPF, DMARC, custom MAIL FROM.
- Sandbox and production access (per Region); sending quota and maximum send rate.
- Configuration sets and event destinations (SNS, CloudWatch, Firehose, EventBridge); bounces and complaints, account-level and configuration-set-level suppression lists, reputation metrics and account reviews.
- SES vs SNS email subscriptions; EC2 restricts outbound port 25 by default; the SMTP interface (credentials derived from IAM) vs the API.
- Cognito's default email vs sending through SES (`scripts/module enable email --param ForCognito=true` passes the identity to auth through injects).
