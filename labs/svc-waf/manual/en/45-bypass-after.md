---
step: bypass-after
---

Verify again now that the origin is locked: the `bypass` after should show `originLocked=true`.

The previous step opened the direct entry only to the workbench (`CDN_ADMIN_CIDR={{ workstation.publicIp }}/32`), so run from the workbench, direct access **still gets through**.
The experiment looks beyond the client: it requests `/api/lab/echo` directly, takes the client address the origin saw, and compares it with cdn's `adminCidr` in capabilities —
an address inside the allow list is recorded as `directAllowedAsAdmin=true` and does not count as "can bypass"; 8080 without a valid `X-Origin-Verify` must still be refused.

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario bypass
```

Now addresses outside the allow list cannot hit EC2 directly to get around the WAF on CloudFront, and the before/after pair shows that the lock-down worked.
To see "other addresses are refused" for yourself, run `curl -m 5 http://<lab instance public IP>/api/health/live` in AWS CloudShell (which is not on the allow list); it should time out.
