---
step: after
---

Record **after**: the same rate-limit attack as step 1, this time down two paths at once — direct (the workbench is the admin IP, so it still gets through and serves as the side-by-side comparison) and the edge entry through CloudFront.

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario flood --param target=both --param rate=8 --param duration=30 --upload
npm run exp:report -- waf
```

::experiment{module=waf id=flood label=after}

:::expected
- **Direct**: still Nginx's 429, effective almost immediately, with every request recorded on the instance.
- **Edge**: requests in the first tens of seconds pass as usual (rate-based rules aggregate over an evaluation window with a detection delay), then `rate-login` blocks them with 429 (path header `waf=aws:block-rate-login`);
  the blocked part no longer appears in the origin log, and the number of requests reaching the origin stays steady during the attack.
:::

:::saa{domain=resilient confusable="Nginx limit_req vs WAF 速率规则"}
`limit_req` counts per second, precisely, and separately on each instance (so the limit is multiplied with several instances); WAF rate-based rules count globally over windows at the edge, with a detection delay,
aggregating behind CloudFront by the real client IP (or `X-Forwarded-For`). The two often work together: the edge stops the bulk, and the origin is the last line.
:::

::checks
