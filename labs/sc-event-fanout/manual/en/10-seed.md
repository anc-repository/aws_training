---
step: seed
---

First, prepare two test users. The script registers two sub-addresses, `+u1` and `+u2`, through the app's public API, verifies the email addresses with the codes in `/api/admin/outbox`
(email starts as the outbox, so verification emails are not really sent), uploads one small public photo for each, and turns on "email notifications". `--no-admins` keeps them as regular users,
so the subscription filter policies match on `userId` only.

```bash {runsOn=workstation}
npm run exp:login -w @cloudalbum/experiments
npx tsx experiments/notification/seed-users.ts --count 2 --email {{ learner.inputs.notify-email }} --no-admins
```

The list is written to `.cloudalbum/experiments/notification-users.json` on the workbench (0600; it contains the passwords of these two test accounts and is only for this experiment).

Then look at the capabilities at the starting point:

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules | {notification: .notification.driver, email: .email.driver}'
```

:::why
**Why create the users in the very first step?** The seed script verifies email addresses with the codes in the outbox; after switching to SES, verification emails really go out, and SES in the sandbox can only send to verified addresses.
Preparing the users while email is still the outbox means the comparison experiments use the same people before and after.
:::

:::expected
The script prints one line per user like `u1  you+u1@…  member  photo=…  邮件通知=on（db）`; notification's driver is `db` and email's driver is `outbox`.
:::

::checks
