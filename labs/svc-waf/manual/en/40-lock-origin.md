---
step: lock-origin
---

Lock down the origin: only CloudFront may fetch from it, and the direct entry is only open to your workbench. After this, WAF cannot be bypassed.

:::tip
Use `--set` (which writes cdn's `ownsEnv` keys), not `--param`. After locking, the platform's Lambda can no longer reach the lab instance's public entry, so later direct-access checks run from the lab instance / workbench instead.
:::

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR={{ workstation.publicIp }}/32 --dry-run
```

When you are happy with them, run it (the cdn stack updates the security group and the direct access policy, and the distribution redeploys, usually in a few minutes):

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR={{ workstation.publicIp }}/32
```
:::

:::expected
`waf` becomes `ok` (DEP-018 disappears); the `bypass` after in the next step shows that direct access is unreachable.
:::
