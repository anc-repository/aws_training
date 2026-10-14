---
step: feedback-loop
---

(Optional) Use the SES mailbox simulator to practice bounce and complaint feedback. Simulator addresses receive mail even in the sandbox and do not affect your account's reputation metrics.

Sign out in the App preview and register one user with each of the two addresses below (the sign-up API allows 20 per IP every 10 minutes):

```text
bounce@simulator.amazonses.com
complaint@simulator.amazonses.com
```

Then open `/admin/outbox` as an admin and wait for the delivery status of these two verification emails to update; meanwhile look at the feedback queue and its DLQ:

```bash {runsOn=workstation}
aws sqs get-queue-attributes --queue-url "{{ var.feedbackUrl }}" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
aws sqs get-queue-attributes --queue-url "{{ var.feedbackDlqUrl }}" --attribute-names ApproximateNumberOfMessages
```

:::expected
Within seconds to minutes, the bounce row changes to “退信” (bounced) and the complaint row to “投诉” (complaint); the `email_status` of the `bounce@…` user becomes `bounced`,
and from then on it only receives the two essential kinds of email, verification and password reset. The worker drains the feedback queue to 0, and the feedback DLQ is 0.
:::

:::why
The event path is the SES configuration set's event destination → the SNS event topic → the SQS feedback queue → the worker. Messages the worker cannot parse go to the feedback DLQ after 5 receives;
the configuration-set-level and account-level suppression lists are the second line of protection.
:::

::checks
