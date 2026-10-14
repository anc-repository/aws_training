---
step: switch-block
---

Once the observation looks fine, switch the managed rule groups to **Block**. `modular-design` §9.2 has no `set` subcommand — changing a parameter means running `enable` again with the new parameter (a stack update).

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable waf --param RuleAction=block --dry-run
```

When you are happy with them, run it (the Web ACL updates the managed rule groups' action, usually taking effect within a minute or two):

```bash {runsOn=workstation}
scripts/module enable waf --param RuleAction=block
```
:::

Send a payload yourself, then look for it in the lab instance's access log:

```bash {runsOn=workstation}
N=edge-$(date +%s); echo "$N"
curl -s -o /dev/null -w "%{http_code}\n" "https://{{ var.cdnDomain }}/api/public/now?q=1%27%20UnIoN%20SeLeCt%201&atlprobe=$N"
```

```bash {runsOn=lab}
sudo grep -c "atlprobe=<the N printed above>" /var/lib/cloudalbum/logs/nginx-access.json
```

:::expected
The request returns **403**, and the count of this nonce in the lab instance's access log is **0** — the request was stopped at the edge and never reached EC2.
The platform's check also sends a payload with a fresh nonce automatically and verifies it the same way.
:::

:::warning
When a managed rule group blocks, it returns **CloudFront's 403 page** without the app's `X-CloudAlbum-Path`; Nginx's regexes also return 403.
Client response headers alone cannot tell which layer blocked the request, so always judge the blocking location by **whether the origin received the request**.
:::

::checks
