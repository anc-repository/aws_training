---
step: baseline
---

Start with the local outbox: in the App preview on the right, sign out and sign up a new user with any address. The success page says "本站未启用真实邮件，验证邮件已写入 outbox" (real email is not enabled on this site; the verification email was written to the outbox);
open `/me/outbox` and click the link in the verification email to complete it — and not a single email ever left EC2.

Then record the before: the runner signs up one test user each for the three SES mailbox simulator addresses (success, bounce, complaint) and your own address, triggers "forgot password",
and reads each email's record from the server (`/api/admin/outbox`):

```bash {runsOn=workstation}
npm run exp:login -w @cloudalbum/experiments
npm run exp -- email --label before --scenario send-matrix --param to={{ learner.inputs.ses-identity }} --upload
```

::experiment{module=email id=send-matrix label=before}

:::expected
In the report, `transport` is `outbox` and `deliveryStatus` is `none` for all four addresses; the top of `/admin/outbox` says "邮件未真正发出（本地 outbox）" (email not really sent (local outbox)).
:::

:::tip
If you want to compare the optional register-latency with this outbox tier, run it once now:
`npm run exp -- email --label before --scenario register-latency` (the sign-up API allows 20 requests per IP per 10 minutes).
:::

::checks
