---
step: enable
---

Enable Cognito: the module deploys the User Pool (`Retain` + deletion protection, email as the username, a password policy, optional TOTP), the public app client `cloudalbum-spa`
and the user groups admin / member, then bulk-migrates the local accounts into the User Pool during a read-only window (`AdminCreateUser` + `MessageAction=SUPPRESS`, so no invitations are sent),
writes `auth.env` and restarts. Finally it runs the `cognito-passwords` hook on the workbench as you to give the test accounts known passwords.

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable auth --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable auth
```
:::

:::wait{typical=4 max=15}
Deploying, migrating and restarting. During the migration you can browse the app but cannot sign up or sign in.
:::

If the output says the hook did not run (for example because the command was interrupted), you can run it again on its own (it is idempotent):

```bash {runsOn=workstation}
scripts/module hooks run --pending
```

:::expected
auth is Degraded, and the only reason is DEP-013 (Cognito sends the verification codes itself, so the local outbox never sees them); the sign-in badge on the page says "登录由 Amazon Cognito 提供" (sign-in provided by Amazon Cognito).
:::

::checks
