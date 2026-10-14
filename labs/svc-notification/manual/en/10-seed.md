---
step: seed
---

First, prepare three test users. The script registers three sub-addresses, `+u1` to `+u3`, through the app's public API, verifies the email addresses with the codes in `/admin/outbox`,
uploads one small public photo for each (you will comment on them later), turns on "email notifications", and then makes them admins (to test "admin broadcasts").

```bash {runsOn=workstation}
npm run exp:login -w @cloudalbum/experiments
npx tsx experiments/notification/seed-users.ts --count 3 --email {{ learner.inputs.notify-email }}
```

The list is written to `.cloudalbum/experiments/notification-users.json` on the workbench (0600; it contains the passwords of these three test accounts and is only for this experiment).

:::why
**Why make them all admins?** For an "admin broadcast" (for example, the daily report is done), the db driver sends to every admin one by one; on the SNS side, a single filter policy
`{"$or":[{"userId":[…]},{"audience":["admin"]}]}` lets every admin receive broadcasts too. That way both sides of the comparison have the same recipients.
:::

Open "设置" (Settings) in the App preview: email notifications are on and took effect immediately — the db driver only flips a boolean and needs no confirmation.

:::expected
The script prints one line per user like `u1  you+u1@…  admin  photo=…  邮件通知=on（db）`; notification's driver in capabilities is `db`.
:::

::checks
