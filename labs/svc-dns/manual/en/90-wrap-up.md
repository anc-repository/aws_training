---
section: wrap-up
---

## What you did

- Gave the album a fixed domain name: emails, share links and `APP_BASE_URL` are no longer tied to an IP.
- Proved with the IP change drill that the name stays fixed while the target can change: old IP links kept failing, and domain links recovered within about one TTL.
- Saw for yourself that an Alias returns an A record directly, and that the zone apex cannot have a CNAME.

## Exam points recap

- Public and private hosted zones; a private hosted zone needs DNS support and DNS hostnames enabled on the VPC.
- A, AAAA, CNAME and Alias: a root domain can only use Alias; Alias queries to AWS resources are free; an Alias cannot point at an IP or an Elastic IP.
- TTLs and caching: lower the TTL before a migration.
- Routing policies: simple, weighted, latency, failover, geolocation, geoproximity, multivalue answer, IP-based; health check types and Evaluate Target Health.
- Domain registration and DNS hosting are two different things; NS delegation; deleting and recreating a hosted zone gives you new NS records.
