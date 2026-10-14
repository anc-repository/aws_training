---
step: enable-cdn
---

A CloudFront custom origin only accepts a **domain name**. So the distribution uses the lab instance's **8080 origin listener** as its origin:
this port is reserved for CloudFront, the security group only allows CloudFront's managed prefix list, and Nginx also checks a request header that only you know.

:::why
Allowing the prefix list is not enough — other people's CloudFront distributions come from the same address ranges. Only `X-Origin-Verify` proves that a request came from *your* distribution.
:::

:::method{kind=script default}
The one-step script generates the origin secret, deploys the 8080 listener, deploys the distribution and the origin security group, waits for the deployment to finish, and then rewrites the media URLs to CloudFront. Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable cdn --dry-run
```

When you are happy with them, run it (it waits for the distribution to deploy, which usually takes a few minutes):

```bash {runsOn=workstation}
scripts/module enable cdn
```
:::

:::wait{typical=5 max=20}
**Why does the origin use 8080 instead of 80?** Ports 80/443 are for direct browser access; 8080 is only for CloudFront, and the security group only opens it to CloudFront's managed prefix list.
While the distribution deploys, you can keep browsing the album in the App preview on the right — everything is still served directly by EC2.
:::

Once the deployment finishes, look at the distribution's origin and behaviors in the console:

::console-link[Open this session's CloudFront distribution]{link=cloudfront.distribution distributionId="{{ var.distributionId }}"}

:::expected
cdn is Healthy and the distribution is Enabled; the origin is `{{ target.publicDns }}:8080` with protocol HTTP only and an `X-Origin-Verify` header;
a direct request to 8080 without the verification header gets 403.
:::

:::warning
Do not change the module-managed distribution (origin, behaviors, policies) in the console: the platform treats them as evidence of completion for this card, and the next `scripts/module` update would overwrite your changes anyway.
:::

::checks
