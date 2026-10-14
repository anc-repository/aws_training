---
step: enable-dns
---

The one-step script deploys the dns stack: a hosted zone (new, or the existing one you pass with `--zone-id`) plus an A record with TTL 60 pointing at the lab instance's Elastic IP,
and then delivers `dns.env` to the lab instance: `APP_BASE_URL` becomes `http://{{ learner.inputs.domain }}`, and from now on emails and share links contain the domain name.

:::method{kind=script default}
Preview the changes first (no API that changes resources is called):

```bash {runsOn=workstation}
scripts/module enable dns --domain {{ learner.inputs.domain }} --target eip --dry-run
```

When you are happy with them, run it. To use an existing hosted zone, add `--zone-id <hosted zone ID>`:

```bash {runsOn=workstation}
scripts/module enable dns --domain {{ learner.inputs.domain }} --target eip
```
:::

With a new hosted zone, the script prints 4 name servers and polls public resolvers until the delegation takes effect (up to 15 minutes; skip it with `--param DelegationWaitMin=0`):

:::wait{typical=5 max=30}
At your registrar (or the parent domain's DNS), add these 4 NS records for `{{ learner.inputs.domain }}`. How long it takes depends on the registrar and the TLD. While you wait, think about this:
**why is the A record's TTL 60 seconds?** Lower the TTL before a migration so old values expire quickly, and users notice a shorter interruption at the switch.
:::

Check the delegation and the record:

```bash {runsOn=workstation}
dig +short NS {{ learner.inputs.domain }} @8.8.8.8
dig {{ learner.inputs.domain }} @8.8.8.8 | grep -A1 'ANSWER SECTION'
curl -s http://{{ learner.inputs.domain }}/api/lab/echo | jq '{host, entry}'
```

:::expected
NS are 4 `awsdns` name servers; the A record is `{{ target.publicIp }}`, with the remaining TTL (≤ 60) in the second column; the `host` that echo returns is your domain —
the Host header the server saw, which shows the request really arrived through the domain.
:::

:::why
**dns is not on the request path.** DNS only does "name → address"; the request itself still goes straight to Nginx on EC2, so this card has no new response headers to look at.
Instead, the sensor resolves the domain on the instance and compares it with the instance's current Elastic IP, and also counts how many requests in the last 5 minutes still used the IP.
:::

::checks
