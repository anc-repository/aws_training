---
step: observe-count
---

Observe false positives in Count mode. `false-positive` sends two **legitimate but suspicious** requests through CloudFront as an admin: a request body over 8 KB, and normal text containing `SELECT * FROM`.

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario false-positive
```

In CloudWatch Logs Insights in **us-east-1** (log group `{{ var.logGroup }}`), see which rules matched:

```sql
stats count() by terminatingRuleId, action
```

Key point: CRS's `SizeRestrictions_BODY` (8 KB) would falsely block photo uploads, so this module **overrides it to Count** (count only, no blocking). The large request body should therefore pass.
