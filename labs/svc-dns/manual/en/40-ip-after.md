---
step: ip-after
---

Run the same IP change drill again. This time, after associating the temporary EIP, the script UPSERTs the record to the new address and then keeps querying public resolvers and requesting the domain link:

```bash {runsOn=workstation}
npm run exp -- dns --label after --scenario ip-change-drill --fault-via local --param env={{ session.env }} --upload
```

::experiment{module=dns id=ip-change-drill label=after}

:::expected
Old IP links still fail (`oldLinkFailures` > 0), but domain links recover within about one TTL: `resolverSwitchSec` and `domainRecoverySec`
are within a minute or two; the report marks before and after as a comparable pair. At the end the record is set back to `{{ target.publicIp }}` and the temporary EIP is released.
:::

:::saa{domain=resilient}
A DNS switch is not instantaneous: resolvers cache answers for the TTL, and some clients cache even longer. Lower the TTL before a migration and switch only after the old TTL has expired;
for switches within seconds, do it at the ALB / CloudFront layer (with an Alias to them, a target change needs no DNS change).
:::

::checks
