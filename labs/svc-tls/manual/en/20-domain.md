---
step: domain
---

In your DNS, add an A record for `{{ learner.inputs.domain }}` pointing at the lab instance `{{ target.publicIp }}` (browsers use it to find the lab instance), then confirm:

```bash {runsOn=workstation}
dig +short {{ learner.inputs.domain }} @8.8.8.8
```

:::expected
The output is `{{ target.publicIp }}`. How long DNS changes take depends on your DNS provider and the record's previous TTL.
:::

**The fallback branch (variant `acme-off`) needs one more thing**: DEP-005 ③ requires "dns or external DNS", so use the external DNS local tier to change the app's effective entry point to your domain
(no AWS resources are deployed and `MODULE_DNS=on` is not written):

```bash {runsOn=workstation}
scripts/module enable dns --driver external --domain {{ learner.inputs.domain }}
```

:::warning
In step 4 the fallback branch changes this name to a CNAME to the CloudFront distribution: one name cannot have both an A and a CNAME, and the apex of an external DNS zone cannot hold a CNAME,
so the fallback branch must use a subdomain (for example `lab.example.com`).
:::

::checks
