---
step: enable-cdn
---

Build a CloudFront distribution in front of the lab instance, and in the same enable **lock down the direct entry**: 80/443 are only open to the admin IP — the workbench's public egress
`{{ workstation.publicIp }}`. CloudFront fetches from the lab instance's 8080 origin listener, which only allows the CloudFront managed prefix list, and Nginx also checks
an `X-Origin-Verify` request header that only this distribution knows.

:::why
**Why lock it down when creating the distribution instead of leaving it open first?** This card's goal is that all traffic must pass through the protection at the edge. While the direct entry is open, any WAF attached later can be bypassed
(DEP-018). The admin IP keeps direct access for operations and for the side-by-side "direct vs edge" comparisons in steps 8 and 9.
:::

:::method{kind=script default}
Preview the changes first (the cdn stack, the origin security group, and `PublicHttpIngress=admin-ip` on the ec2 base stack):

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR={{ workstation.publicIp }}/32 --dry-run
```

When you are happy with them, run it (the script generates the origin secret, deploys the 8080 listener, deploys the distribution and waits for it to finish):

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR={{ workstation.publicIp }}/32
```
:::

:::tip
Use `--set` (which writes the `CDN_*` keys owned by cdn), not `--param`. With `CDN_DIRECT_ACCESS=admin-ip` but no `CDN_ADMIN_CIDR`, the script refuses to run with exit code 2.
:::

:::wait{typical=6 max=20}
It takes a few minutes for the distribution to go from "Deploying" to "Enabled". You can keep browsing the album in the App preview meanwhile; once the lock takes effect, the preview switches to the distribution domain.
:::

::console-link[Open this session's distribution]{link=cloudfront.distribution distributionId="{{ var.distributionId }}"}

:::expected
cdn is Healthy; a request to `/api/health/live` through the distribution has a path header starting with `entry=cloudfront>nginx`; the origin is `{{ target.publicDns }}:8080`,
HTTP only, with an `X-Origin-Verify` header.
:::

::checks
