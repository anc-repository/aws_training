---
step: after-payloads
---

Record the second part of **after**: the same payloads sent to both direct and edge at once, paired with the before from step 2.

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario payloads --param target=both --upload
npm run exp:report -- waf --experiment payloads
```

::experiment{module=waf id=payloads label=after}

:::expected
The edge side blocks no fewer payloads than the direct side, especially encoded and mixed-case variants; `caughtOnlyByWaf` lists the variants Nginx missed and the managed rule groups blocked.
Requests blocked by managed rule groups return CloudFront's 403 and also never enter the origin log.
:::

:::tip
AWS keeps updating managed rule groups, so the same payloads may give slightly different results at different times; that is exactly how they differ from hand-written regexes.
:::

::checks
