---
step: enable
---

Enable the instance role: the module deploys a read-only policy `cloudalbum-{{ session.env }}-iam`, attaches it to `CloudAlbumAppRole`, writes `IAM_CREDENTIALS=role` and restarts the app.

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable iam --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable iam
```
:::

:::wait{typical=2 max=10}
Deploying the policy stack, attaching the policy and restarting. IAM changes are eventually consistent, so the probe may take a few seconds to see the new permissions.
:::

:::expected
iam is Healthy, and detail shows `assumed-role/CloudAlbumAppRole/<instance ID>` and the `ASIA` prefix; the role's permissions list now also has `cloudalbum-{{ session.env }}-iam`.
:::

:::saa{domain=secure confusable="GetCallerIdentity vs 授权"}
`sts:GetCallerIdentity` needs no permission at all, and even an explicit Deny cannot block it: it only proves "authentication succeeded and who I am", not "I am allowed".
That is why the module's health check adds one more call that is restricted by policy (`iam:GetRole`).
:::

::checks
