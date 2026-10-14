---
section: overview
---

## Background

L0's "firewall" is Nginx on EC2: `limit_req` rate limiting plus a few regular expressions stop obvious attacks, but **every malicious request has already reached the instance**, consuming connections, TLS, logs and bandwidth.
This card attaches **AWS WAF** to CloudFront to block at the edge with managed rules and rate-based rules — blocked requests never reach EC2 at all. The prerequisite is that the origin is **locked down**; otherwise attackers can go around it.

:::why
WAF works at layer 7 and can only be associated with CloudFront, ALB, API Gateway REST APIs and the like, not with EC2 / EIP / NLB (DEP-006). CLOUDFRONT-scope
Web ACLs, IP sets and log groups all live in **us-east-1**, separate from the app's Tokyo Region.
:::

:::warning
Point attack scripts only at resources in your own account, keep the rate low (short rounds), and follow AWS's penetration testing policy (see the official documentation). Do not push `flood` to flooding levels.
:::

## Comparison experiments

### Rate limiting (waf/flood, required)

- **Without AWS WAF (Nginx)**: hitting the direct entry from a single source at slightly above the threshold, Nginx's `limit_req` blocks with 429 almost immediately, but every request still reaches the instance.
- **With AWS WAF**: the same attack aimed at CloudFront; rate-based rules aggregate over a window with a detection delay (tens of seconds), and blocked requests never go to the origin.
- **Where you see it**: the nonce counts from `/api/lab/waf/origin` — with direct access every request lands in the origin log, while requests blocked by WAF never do.
- **If the results are not what you expect**: check that `WAF_LAB_ALLOW_CIDR` is empty (otherwise the lab instance skips all rules), and that the origin is locked with direct access open to the workbench.

### Attack payload detection (waf/payloads, required)

Nginx's few regexes are easily bypassed with double encoding / case / comment variants; AWS managed rule groups detect more. `caughtOnlyByWaf` in the results lists the variants Nginx missed and WAF blocked.

### Origin lock-down (waf/bypass, required)

Request the lab instance's direct port and 8080 directly: while unlocked, direct access gets through (WAF can be bypassed, DEP-018); after locking, direct access is refused or times out, and 8080 returns 403 because `X-Origin-Verify` does not match.

### False positives (waf/false-positive, required)

Legitimate but "suspicious" requests: a large request body (CRS's `SizeRestrictions_BODY` is overridden to Count, so it should pass) and normal text containing SQL keywords (which the SQLi rule may falsely block in Block mode).

## Platform mode notes

`scripts/module enable waf` creates the Web ACL in us-east-1 and injects `WebAclArn` into the cdn stack (the distribution redeploys for a few minutes). The platform confirms the Web ACL is yours through this session's waf module stack;
a managed rule group Block returns CloudFront's 403 without the app's path header, so the response headers you see in the browser are for observation only, and where a request was blocked is decided by **whether the origin received it**.
