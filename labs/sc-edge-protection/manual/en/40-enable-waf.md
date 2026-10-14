---
step: enable-waf
---

Attach AWS WAF to the distribution. The module creates, in **us-east-1**, the Web ACL (CLOUDFRONT scope), the IP set `cloudalbum-blocklist` and the log group
`{{ var.logGroup }}`, then injects `WebAclArn` into the cdn stack, and the distribution redeploys. The managed rule groups start on **Count** (count only, no blocking).

:::method{kind=script default}
Preview the changes first (note the stack name `cloudalbum-{{ session.env }}-waf-edge` and the Region us-east-1):

```bash {runsOn=workstation}
scripts/module enable waf --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable waf
```
:::

:::wait{typical=6 max=20}
The Web ACL is deployed in us-east-1 first, then the cdn stack is updated; until the distribution finishes redeploying, waf may briefly show “Web ACL 未关联？” (Web ACL not associated?) — an expected wait.
:::

The enable script also does a first full import of the instance's `denylist.conf` into the IP set. When it finishes, check the status on the lab instance and make one request through the distribution from the workbench:

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.waf | {driver, status, detail}'
```

```bash {runsOn=workstation}
curl -sI "https://{{ var.cdnDomain }}/api/health/live" | grep -i "^x-cloudalbum-path:"
```

In the WAF console (choose the **Global (CloudFront)** Region), look at the rule order, each rule's WCU, and the "Sampled requests":

::console-link[Open the list of WAF Web ACLs]{link=wafv2.webAcls}

:::expected
waf is Healthy (the origin is already locked, so there is no DEP-018); the path header starts with `entry=cloudfront>waf>nginx` — the Web ACL's default action inserts
`x-amzn-waf-cloudalbum` into allowed requests, and Nginx uses it to write waf into the entry chain; the distribution's WebACLId is this session's Web ACL ARN.
:::

:::saa{domain=secure confusable="WAF 的两种范围"}
CLOUDFRONT-scope Web ACLs, IP sets and rule groups can only be created in us-east-1; the REGIONAL scope (ALB, API Gateway, AppSync, Cognito user pools)
is created in the resource's Region. A Web ACL created in ap-northeast-1 does not appear in the distribution's drop-down.
:::

::checks
