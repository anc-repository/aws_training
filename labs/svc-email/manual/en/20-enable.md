---
step: enable
---

Wire in SES. The module creates the email address identity `{{ learner.inputs.ses-identity }}` (adopted read-only if it already exists), a configuration set (reputation metrics, configuration-set-level suppression of BOUNCE / COMPLAINT),
an event topic and a feedback queue (+ DLQ), a CloudWatch event destination with the `category` tag as its dimension, and a customer managed policy that only allows sending from this identity
(`ses:SendEmail` restricted with a `ses:FromAddress` condition).

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable email --param Email={{ learner.inputs.ses-identity }} --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable email --param Email={{ learner.inputs.ses-identity }}
```
:::

:::wait{typical=5 max=20}
Once the stack is deployed, the script checks the identity's status every 15 seconds. Find "Amazon Web Services – Email Address Verification Request" in your mailbox and click the link;
only when the script sees Verified does it write env, restart the processes and send a probe email to the SES mailbox simulator. If you do not verify within 15 minutes, it exits with code 5 (the stack stays);
after verifying, just run the same command again.
:::

After verification, sign up a new user with `success+demo@simulator.amazonses.com` in the app preview (the SES mailbox simulator receives mail even in the sandbox),
then look at the capabilities status:

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.email | {driver, status, detail}'
```

::console-link[Open the feedback queue in the SQS console]{link=sqs.queue queueUrlEncoded="{{ var.feedbackUrl | url }}"}

:::expected
email's driver is `ses`; in the sandbox the status is yellow and detail starts with "沙盒：只能发给已验证地址 · 今日已发 n / 上限 m" (sandbox: can only send to verified addresses · sent today n / limit m; the limit comes from `GetAccount`) —
that is expected, not a fault. The path header of the sign-up request contains `email=ses:sent`.
:::

:::saa{domain=secure confusable="SES 沙盒 vs 生产访问"}
SES in a new account is in the sandbox per Region: it can only send to verified addresses, domains and the mailbox simulator, with very low volume and rate limits. Production access is a separate request with a human review;
another Region needs another request.
:::

::checks
