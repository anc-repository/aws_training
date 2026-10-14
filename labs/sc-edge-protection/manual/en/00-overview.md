---
section: overview
---

## Background

A month after the album launched, the sign-in API gets tens of thousands of credential stuffing attempts a day, and the access log is full of scans such as `/wp-login.php` and `/.env`. The starting point is L0: the entry point is the lab instance's Elastic IP,
and the only protection is Nginx on the instance — `limit_req` rate limiting, a few regular expressions and a `denylist.conf`. They stop some of it, but **every malicious request has already reached EC2**,
using up the instance's connections, TLS and bandwidth.

Starting from L0, this card has you do three things yourself: build a CloudFront distribution in front of the instance and keep direct access for the admin IP only; create a Web ACL in us-east-1 and associate it with the distribution,
observing false positives with the managed rule groups in Count before switching to Block; and finally prove with origin logs that "blocked requests never reached EC2".

## Architecture

### At the start

![At the start: attackers and users both hit the lab instance's Elastic IP directly, and the only protection is Nginx](assets/arch-start.svg)

### When done

![When done: traffic goes through CloudFront and the Web ACL in us-east-1 first; origin port 8080 only allows the CloudFront prefix list and the verification header, and direct access is open only to the admin IP](assets/arch-end.svg)

## Why combine them

- **WAF needs an entry point to attach to**: it cannot be associated with EC2, Elastic IPs or NLBs, only with resources such as CloudFront, ALB and API Gateway REST APIs (DEP-006).
  This card picks CloudFront: TLS termination and WAF inspection both happen at the edge, blocked requests never enter the Tokyo Region, and there is no hourly-billed load balancer.
- **The CLOUDFRONT scope lives in us-east-1**: the Web ACL, IP set and WAF log group are all created in us-east-1 (stack `cloudalbum-{{ session.env }}-waf-edge`),
  separate from the app's ap-northeast-1.
- **Only a locked origin counts**: the lab instance's 80/443 are only open to the admin IP; the 8080 origin listener only allows the CloudFront managed prefix list, and Nginx also checks
  `X-Origin-Verify`, which only this distribution knows. Turn on WAF without locking the origin, and attackers bypass every rule by hitting the Elastic IP directly (DEP-018).
- **Shield and GuardDuty each cover a different layer**: Shield Standard applies automatically to every CloudFront distribution and defends against common network and transport layer DDoS;
  GuardDuty analyzes CloudTrail, VPC Flow Logs and DNS logs and only produces findings — it never blocks and never looks at HTTP content.
- **Common wrong combinations**: locking the origin with only the prefix list (other people's distributions come from the same ranges); creating the Web ACL in ap-northeast-1 and then trying to associate it with the distribution;
  switching managed rules straight to Block without observing in Count (CRS falsely blocks the large request bodies of photo uploads); buying Shield Advanced against credential stuffing.

## Comparison experiments

Every attack targets only the lab instance in your own account, in short rounds at low rates just above the thresholds, following AWS's penetration testing policy (see the official documentation).

### Rate limiting (waf/flood, required)

- **At the start**: from the workbench, `POST /api/auth/login` at slightly above the threshold; Nginx's `limit_req` answers 429 almost immediately, but every request reached the instance.
- **When done**: the same attack aimed at CloudFront; rate-based rules aggregate over a window with a detection delay (tens of seconds), and blocked requests never go to the origin.
- **Where you see it**: the block ratio and time of the first block in the report; the server-side evidence is the count of this run's nonce in the origin access log (`/api/lab/waf/origin`), not the response headers the client sees.

### Attack payload detection (waf/payloads, required)

The same set of public WAF test payloads (SQL injection and its encoded variants, directory traversal, XSS, a Log4Shell probe and scanner User-Agents) is sent down both paths.
Nginx's few regexes miss double-encoded, case and comment variants; `caughtOnlyByWaf` in the results lists the variants Nginx missed and the managed rule groups blocked.

### False positives (waf/false-positive, required)

In Count mode, send two legitimate but "suspicious" requests: a request body over 8 KB and normal text containing `SELECT * FROM`, and see which rules match,
and why this module overrides CRS's `SizeRestrictions_BODY` to Count.

### Why not waf/bypass

The workbench's public egress is the very admin IP you set, so probing port 80 from the workbench always gets through. Instead, this card proves "cannot be bypassed" with server-side evidence: the rules of the lab instance and origin security groups,
a 403 for a request to 8080 without the verification header from the lab instance itself, and a timeout when you connect directly from CloudShell (not the admin IP).

## Platform mode notes

- `scripts/module enable waf` deploys the stack `cloudalbum-{{ session.env }}-waf-edge` in us-east-1 with your learner identity, then injects `WebAclArn` into the cdn stack, and the distribution redeploys (a few minutes).
- After the origin is locked, the platform's Lambda cannot reach the lab instance's public entry, and the security group blocks the direct preview; the App preview switches to the distribution domain, and later direct-access checks all run from the lab instance itself.
- `WAF_LAB_ALLOW_CIDR` must stay empty: it is an Allow action that lets the listed addresses skip every rule.
