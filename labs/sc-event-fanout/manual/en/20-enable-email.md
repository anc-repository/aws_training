---
step: enable-email
---

Wire in SES. The module creates the email identity `{{ learner.inputs.ses-identity }}` (attaching read-only if it already exists), a configuration set (reputation metrics, configuration-set-level suppression of BOUNCE / COMPLAINT),
an event topic and feedback queue (+ DLQ), and a customer managed policy that only allows sending from this identity.

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
Once the stack is deployed, the script checks the identity status every 15 seconds. Find "Amazon Web Services – Email Address Verification Request" in your mailbox and click the link;
the script only writes env and restarts the processes once it sees "verified". If it is not verified within 15 minutes, it exits with code 5 (the stack is kept); run the same command again after verifying.
:::

Once verified, make a transactional email **really** reach your inbox: sign out in the App preview and register a new user with `{{ learner.inputs.ses-identity }}`
(if that address is already registered, use “忘记密码” (forgot password) on the sign-in page to send a reset email). Then look at the capabilities and the account's sandbox status:

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.email | {driver, status, detail}'
```

```bash {runsOn=workstation}
aws sesv2 get-account --query "{production:ProductionAccessEnabled,quota:SendQuota}"
aws sns list-subscriptions-by-topic --topic-arn "{{ var.emailEventsTopicArn }}" --query "Subscriptions[].[Protocol,Endpoint]" --output table
```

::console-link[Open the feedback queue in the SQS console]{link=sqs.queue queueUrlEncoded="{{ var.feedbackUrl | url }}"}

:::expected
The email arrives in your inbox, and the sign-up request's path header contains `email=ses:sent`; email's driver is `ses`, yellow in the sandbox, with a detail starting “沙盒：只能发给已验证地址” (sandbox: can only send to verified addresses) —
expected, not a fault; `get-account` shows `production: false`; the SES event topic has a single subscription: protocol `sqs`, pointing to `cloudalbum-{{ session.env }}-email-feedback`.
:::

:::why
**Why must bounces come back to the app?** When bounce or complaint rates get too high, the account can be put under review or even have sending paused (see the official documentation for thresholds). Configuration set → SNS → SQS lets the app pull these events itself:
the lab instance only opens outbound connections and needs no inbound port; while the worker is down, events stay in the queue and are processed as usual after recovery.
:::

:::saa{domain=secure confusable="SES 沙盒 vs 生产访问"}
SES in a new account starts in the sandbox, per Region: it can only send to verified addresses, domains and the mailbox simulator, with low sending volume and rate. Production access must be requested separately and is reviewed by a person; a different Region needs a new request.
:::

::checks
