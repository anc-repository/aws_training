---
step: signup
---

In the app preview, sign up a new account with **your own email address**. The front end's Amplify submits the sign-up form straight to the User Pool, and EC2 never handles the password.

1. Open the preview, choose "注册" (sign up), and enter your email address and a password (at least 10 characters, with upper- and lower-case letters and digits).
2. Find the verification code from Cognito in your mailbox (the sender is Cognito's default address), complete the verification on the page and sign in.
3. Open "我的邮件" (my mail, `/me/outbox`): this verification email is not there.

:::expected
The verification email is in your own mailbox and not in the local outbox; auth in `/api/capabilities` is degraded, because of DEP-013.
:::

:::warning
Do not sign up with someone else's email address: emails sent by Cognito cannot be recalled. The default sending quota per day is very low; if nothing arrives, try again later.
:::

::checks
