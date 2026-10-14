---
step: after
---

Record **after**: the same attacks aimed at the edge (through WAF), paired with the before from step 2.

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario flood --param target=both --param rate=8 --param duration=30
npm run exp -- waf --label after --scenario payloads --param target=both
```

What to compare:

- **Rate limiting**: Nginx works per second, almost immediately, with an exact burst; AWS WAF aggregates over an evaluation window with a detection delay (tens of seconds), and the number allowed through may not exactly match the threshold.
- **Origin load**: during the attack, the number of requests reaching the origin through the CloudFront entry stays steady — blocked requests never go to the origin.
- **Payload detection**: AWS managed rule groups recognize encoding variants better than Nginx's few regexes (`caughtOnlyByWaf` lists the variants Nginx missed and WAF blocked).
