---
section: overview
---

## Background

At L0 the album is reached at `http://<EIP>`: that IP is in the browser's address bar, in the sign-up verification emails and in share links. As soon as the address changes — a new instance, a network migration,
an ALB or CloudFront in front — every link already sent out breaks. Amazon Route 53 gives the album a fixed name: the target behind the name can change at any time,
and the links in users' hands point at the new target on their own once the TTL passes.

:::warning
**Manual prerequisite: your own domain.** This card needs a domain whose DNS you can manage, one of: ① a Route 53 public hosted zone for the domain (or a subdomain of it) already exists in this account — recommended,
no waiting for delegation; ② you can add an NS delegation for a subdomain (for example `lab.example.com`) at your registrar or parent domain — how long that takes depends on the registrar and the TLD, and it may exceed the card's time limit.
Without a domain this card cannot be completed: `scripts/module enable dns` prints a message and exits with code 2 without deploying anything.
:::

:::why
Domain registration and DNS hosting are two different things: the registrar decides who owns the domain and which name servers answer for it; the hosted zone decides how those name servers answer.
A new hosted zone has its own 4 name servers, and only after the registrar (or parent domain) points NS at them do resolvers around the world start asking Route 53.
:::

## Comparison experiments

### IP change drill (dns/ip-change-drill, required)

- **Without Route 53**: the drill script allocates a temporary Elastic IP and associates it with the lab instance to simulate "the instance was replaced and the IP changed"; old IP links are probed every 5 seconds and all fail.
- **With Route 53**: in the same drill, the script UPSERTs the record to the new IP; public resolvers return the new address within roughly one TTL (60 seconds), and domain links recover on their own.
- **Where you will see it**: `oldLinkFailures`, `domainFailures`, `resolverSwitchSec` and `domainRecoverySec` in the comparison report; the server-side evidence is the lab instance's
  dns sensor results and request `Host` distribution, and the `Host` the server sees when you request `/api/lab/echo` through the domain.
- **If the results are not what you expect**: check that both runs had `--fault-via local` (the drill script calls the AWS CLI on the workbench); the delegation must be in effect before the after run.

### Failover (dns/failover-drill, optional)

The primary record carries a health check; after you stop Nginx, clients get the secondary record (a static maintenance page on S3) after "check interval × failure threshold + TTL + caching".

## Platform mode notes

This card creates the hosted zone (or uses your existing one) and the records in one go with `scripts/module enable dns`. The platform confirms ownership through this session's dns stack;
the NS delegation you add at your registrar and any records you create by hand in the console are outside the platform's reclaim — clean them up yourself before you end the lab.
