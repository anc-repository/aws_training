---
section: wrap-up
---

You have covered:

- Where WAF can be attached (CloudFront, ALB, API Gateway REST APIs and more) and which resources it cannot (EC2, EIP, NLB);
- CLOUDFRONT-scope Web ACLs, IP sets and log groups all live in **us-east-1**;
- Managed rule groups go Count first and Block later, and CRS's `SizeRestrictions_BODY` falsely blocks large request bodies unless overridden;
- Rate-based rules aggregate over a window with a detection delay, unlike Nginx's precise rate limiting;
- Origin lock-down and "bypassing WAF", and why **server-side evidence** decides where a request was blocked.
