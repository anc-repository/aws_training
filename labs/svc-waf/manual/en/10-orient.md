---
step: orient
---

First, get a clear view of the start state: `waf` is still the local implementation (`WAF_MODE=nginx`), and `cdn` is enabled, but its direct entry is **not locked** (`CDN_DIRECT_ACCESS=open`) —
deliberately, so you can see for yourself in steps 2 and 3 that WAF can be bypassed.

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules | {waf: .waf.driver, cdn: .cdn.driver}'
```

This card's WAF sits on **CloudFront** (CLOUDFRONT scope): the Web ACL, IP set and log group are all in **us-east-1**, separate from the app's Tokyo Region.

:::expected
`waf`'s driver is `nginx` and `cdn`'s driver is `cloudfront`. So rate limiting and blocking still happen on the instance, and there is no WAF at the edge yet.
:::
