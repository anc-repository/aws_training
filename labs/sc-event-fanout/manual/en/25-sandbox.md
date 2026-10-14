---
step: sandbox
---

What happens in the sandbox when you send to an **unverified** address? Pick an address you control but have not verified in SES (do not use reserved domains such as example.com — EmailPort does not call SES for them).
The runner registers a test user with it, hands the verification email to EmailPort, and then reads the server's send records:

```bash {runsOn=workstation}
npm run exp -- email --label after --scenario sandbox --param to=<an unverified address> --upload
```

::experiment{module=email id=sandbox label=after}

Open `/admin/outbox` as an admin in the App preview and find this verification email.

:::expected
Status `failed` (in red), error `MessageRejected: Email address is not verified …`, path segment `email=ses:rejected`; the sign-up itself completes as usual.
:::

:::why
The SES adapter never quietly rewrites a failed email as "sent": when a non-authoritative port fails it records `failed`, and the sign-up completes as usual. `EMAIL_SANDBOX_POLICY=outbox`
(`scripts/module enable email --set EMAIL_SANDBOX_POLICY=outbox`) is a demo option you must choose explicitly; this card keeps the default `fail`.
:::

::checks
