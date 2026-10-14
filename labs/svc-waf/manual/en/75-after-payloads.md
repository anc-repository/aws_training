---
step: after-payloads
---

Record the second part of **after**: the same payloads aimed at the edge (through AWS WAF), paired with the before from step 3.

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario payloads --param target=both
```

AWS managed rule groups recognize encoding variants better than Nginx's few regexes; `caughtOnlyByWaf` in the results lists the variants Nginx missed and WAF blocked.
