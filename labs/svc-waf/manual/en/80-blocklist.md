---
step: blocklist
---

(Optional) IP blocking and Shield.

In the admin console at `/admin/security`, block an address reserved for documentation (for example `192.0.2.1`): the local `denylist.conf` takes effect immediately (Nginx reloads), and it is synced to the IP set `{{ var.ipSetName }}` in us-east-1.

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/admin/security/blocklist | jq '{driver, ipSet, lastSync}'
```

Read up on the difference between **Shield Standard** (automatic and free, protects against network/transport-layer DDoS) and **Shield Advanced** (paid, with the DDoS response team and cost protection); for central management across accounts, use **Firewall Manager**.

:::expected
The admin endpoint returns `driver: aws` and `lastSync.ok` is `true` — the block has been synced from the local denylist to the IP set in us-east-1.
:::
