---
step: sandbox
---

What happens in the sandbox when you send to an address you have **not verified**? Pick an address you control that is not verified in SES (do not use reserved domains such as example.com —
EmailPort does not call SES for them). The runner signs up a test user with it, hands the verification email to EmailPort, and then reads the server's sending record:

```bash {runsOn=workstation}
npm run exp -- email --label after --scenario sandbox --param to=<an unverified address>
aws sesv2 get-account --query "{production:ProductionAccessEnabled,quota:SendQuota}"
```

::experiment{module=email id=sandbox label=after}

Find this verification email in `/admin/outbox`.

:::expected
Status `failed` (in red), error `MessageRejected: Email address is not verified …`, path segment `email=ses:rejected`;
`get-account` shows `production: false`. If `EMAIL_SANDBOX_POLICY=outbox` is set, rejected emails are rewritten into the local outbox and likewise marked "未真正发出" (not really sent).
:::

:::why
The SES adapter never quietly rewrites a failed email as "sent": when a non-authoritative port fails it records `failed`, the module becomes degraded, and the sign-up itself is not affected.
`EMAIL_SANDBOX_POLICY=outbox` (`scripts/module enable email --set EMAIL_SANDBOX_POLICY=outbox`) is an explicitly chosen demo option that lets new users who sign up during the sandbox period
complete verification in `/me/outbox`.
:::

::checks
