---
step: domain-identity
---

If you have your own domain, switch to a **domain identity**: with Easy DKIM turned on, SES generates 3 CNAME records. The domain is `{{ learner.inputs.domain }}` (a subdomain is recommended, for example `mail.<your domain>`).

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable email --param Domain={{ learner.inputs.domain }} --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable email --param Domain={{ learner.inputs.domain }}
```
:::

The script prints `InfoDkimRecords`: 3 records `<token>._domainkey.<domain> CNAME <token>.dkim.amazonses.com`. Add them exactly as given at your DNS provider
(if the dns module is enabled, the stack writes them to Route 53).

:::wait{typical=10 max=20}
Only after DNS propagates can SES verify the domain and the DKIM status turn to Successful; the script polls until the identity is verified and only then writes env.
:::

:::expected
`DkimAttributes.Status` of `aws sesv2 get-email-identity --email-identity {{ learner.inputs.domain }}` is `SUCCESS`;
from then on, the `d=` in the `DKIM-Signature` of outgoing email is your domain, aligned with the sending domain.
:::

:::tip
When you are done, remember to delete the DKIM records you added by hand at your external DNS provider.
:::

::checks
