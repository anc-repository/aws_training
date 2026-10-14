---
step: failover
---

(Optional) Change the routing policy to failover: PRIMARY = the lab instance's EIP plus a health check (on `origin.<domain>/api/health/ready?scope=instance`),
SECONDARY = a maintenance page in an S3 static website bucket with the same name as the record.

```bash {runsOn=workstation}
scripts/module enable dns --domain {{ learner.inputs.domain }} --target eip --param RoutingPolicy=failover
```

:::why
An S3 website endpoint finds the bucket by the Host header, so the bucket name must be exactly the record name, and it only supports HTTP. If the site already enforces HTTPS, fail over at the CDN layer with a CloudFront
origin group instead of at the DNS layer. Health check metrics and alarms only exist in us-east-1.
:::

Run the drill: at second 10 it stops Nginx on the lab instance, and it restores it at the end.

```bash {runsOn=workstation}
npm run exp -- dns --label after --scenario failover-drill --fault-via ssm --upload
```

::experiment{module=dns id=failover-drill label=after}

:::expected
`marks` shows, in order, `unhealthy` (the health check turned unhealthy), `secondaryAnswer` (public resolvers returned the maintenance bucket's address) and `maintenanceOk`;
the whole thing takes tens of seconds to a few minutes. Afterwards, set the routing policy back to `simple` (`--param RoutingPolicy=simple`).
:::

::checks
