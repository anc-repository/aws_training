---
step: before-lockout
---

Record the before: submit a wrong password 30 times in a row for one test account and record the sequence of response codes. Do **not** run it against the admin account (it would be locked, and the script refuses).

```bash {runsOn=workstation}
npm run exp -- auth --label before --scenario brute-force --param email=atl-test-3@example.com --upload
```

::experiment{module=auth id=brute-force label=before}

:::expected
The sequence in the report looks like `401×5, 423×…` or includes `429`: the local driver counts failures per account and locks it, and Nginx also rate-limits per source.
:::

:::why
**The cost of local lockout**: the counter has to live somewhere. With a single instance it is the local database; once you scale out to several instances the state must be shared, otherwise an attacker gets around it simply by spreading requests across instances.
Cognito's temporary lockout is global, so the app does not have to worry about it.
:::

::checks
