---
step: enable
---

Attach AWS WAF to CloudFront, starting in **Count** mode to observe (the managed rule groups only count and do not block yet).

:::why
When you newly enable managed rule groups, start with Count, read a few minutes of COUNT records from real traffic, confirm there are no false positives, and only then switch to Block — otherwise you can easily block real users (photo uploads, for example).
:::

:::method{kind=script default}
```bash {runsOn=workstation}
scripts/module enable waf --dry-run
```

When you are happy with it, run it (it deploys the Web ACL in us-east-1, then injects `WebAclArn` into the cdn stack and the distribution redeploys, usually in a few minutes):

```bash {runsOn=workstation}
scripts/module enable waf
```
:::

The enable script also does a first full import of the instance's `denylist.conf` into the IP set `cloudalbum-blocklist` (us-east-1). The origin is still unlocked, so `waf` shows `degraded` because of **DEP-018** — expected in this card, and the next step fixes it.
