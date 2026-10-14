---
section: cleanup
---

When the session ends, the platform reclaims automatically: it first updates the cdn stack with an empty `WebAclArn` to **disassociate** the Web ACL (the distribution redeploys for a few minutes), then deletes the Web ACL and IP set in us-east-1 — a Web ACL that is still associated cannot be deleted.

- The WAF log group `{{ var.logGroup }}` is in **us-east-1** and is **kept** under the data protection convention; remember to switch to us-east-1 when you query it in Logs Insights yourself.
- If you set `WAF_LAB_ALLOW_CIDR` for another experiment, clear it before the lab ends: it is an Allow action that lets that address skip every rule.
