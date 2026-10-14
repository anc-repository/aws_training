---
section: cleanup
---

- Automatic reclaim first updates the cdn stack with an empty `WebAclArn` to **disassociate** the Web ACL (the distribution redeploys for a few minutes), then deletes the Web ACL and IP set in us-east-1 — a Web ACL that is still associated cannot be deleted.
- It then disables and deletes the distribution and deletes the origin security group, cache policy and 8080 listener; the lab instance is deleted with the session, and the tightened 80/443 go with it.
- The WAF log group `{{ var.logGroup }}` is in **us-east-1** and is kept until the reclaimer's cleanup stage under the data protection convention; remember to switch to us-east-1 when you query it in Logs Insights yourself.
- If you set `WAF_LAB_ALLOW_CIDR` for another exercise, clear it before the lab ends: it is an Allow action that lets that address skip every rule.
- This card neither subscribed to Shield Advanced nor enabled GuardDuty, so there is no account-level state to clean up.
