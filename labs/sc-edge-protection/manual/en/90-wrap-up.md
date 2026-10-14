---
section: wrap-up
---

## What you did

- Built a CloudFront distribution from L0 and, in the same enable, kept direct access for the admin IP only; origin port 8080 only accepts the CloudFront prefix list + `X-Origin-Verify`.
- Created a CLOUDFRONT-scope Web ACL in us-east-1: two rate-based rules (sign-in and site-wide), an IP set and four AWS managed rule groups; observed false positives in Count first, then switched to Block.
- Proved with the nonce counts in the origin log that requests blocked by WAF never reached EC2; proved with security group rules and direct connections from CloudShell that attackers cannot go around the edge.

## Overall comparison

| Measure | At the start | When done |
|---|---|---|
| Where malicious requests are handled | Nginx on EC2 | WAF at the CloudFront edge |
| Requests reaching the origin during an attack | Rise with the attack, and refused ones still reach the instance | Blocked requests never go to the origin; origin load stays about steady |
| Paths around the protection | There is no "protection layer" to go around | 80/443 open only to the admin IP, 8080 only accepts this distribution |
| Malicious payload detection | A few hand-written regexes that miss encoded variants | Managed rule groups, continuously updated |
| Limits with several instances | Each instance counts on its own | The Web ACL counts globally |
| Basic DDoS protection | None | Shield Standard on automatically |
| Observability | Aggregated Nginx logs | Sampled requests, CloudWatch metrics and WAF logs (us-east-1) |

## Exam points recap

- Where WAF attaches (CloudFront, ALB, API Gateway REST APIs, AppSync, Cognito user pools and more) and which resources it cannot (EC2, Elastic IPs, NLB); the CLOUDFRONT scope lives in us-east-1.
- Web ACLs, rule groups, managed rule groups, rate-based rules, IP sets and geo match; Count mode, rule action overrides, scope-down statements and WCUs.
- Origin protection: the CloudFront managed prefix list + a custom request header; OAC for S3 origins; VPC origins leave the origin with no public entry at all.
- The division of labor between security groups / NACLs (layers 3/4) and WAF (layer 7); getting the real client IP behind CloudFront from `X-Forwarded-For`.
- Shield Standard vs Shield Advanced; Firewall Manager; GuardDuty only detects, never blocks, and complements WAF.
