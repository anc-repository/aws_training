---
step: baseline
---

Record **before**: rate limiting and signature blocking with Nginx alone. Run two short rounds of experiments from the workbench against the **direct** entry.

:::tip
`WAF_LAB_ALLOW_CIDR` must be empty — it is an Allow action that lets allow-listed addresses skip every rule (meaningless for waf's own experiments).
:::

```bash {runsOn=workstation}
npm run exp -- waf --label before --scenario flood --param target=direct --param rate=8 --param duration=30
npm run exp -- waf --label before --scenario payloads --param target=direct
```

- `flood`: hits `POST /api/auth/login` from a single source at slightly above the threshold. Nginx's `limit_req` blocks with **429** almost immediately (path header `waf=nginx:ratelimit`), but every request still reaches the instance.
- `payloads`: a set of public WAF test payloads. Notice that Nginx's few regexes **miss** double-encoded, case and comment variants.
