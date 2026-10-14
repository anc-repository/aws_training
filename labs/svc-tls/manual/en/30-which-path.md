---
step: which-path
---

Look at the plan first: `scripts/module` calls `acm:ListAcmeEndpoints` with your identity to probe the ACME endpoint (preflight `acme-endpoint`, read-only).
If it is available, `TLS_ACME=on`; if the command does not exist, the Region does not support it, or permissions or an SCP deny it, it counts as unavailable and falls back to `TLS_ACME=off`.

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }} --dry-run 2>&1 | grep -E 'preflight|TLS_ACME|DEP-005'
```

:::expected
There is a line `preflight acme-endpoint：…` giving `TLS_ACME=on` or the reason for the fallback; when falling back there is also an explanation of the DEP-005 ③ dependencies (dns or external DNS + cdn or load-balancer).
`--dry-run` does not call AWS, so it plans with `TLS_ACME=on`; only a real run without `--dry-run` probes.
:::

:::tip
To practice the exam setup, add `--no-acme`: it writes `TLS_ACME=off` directly without probing. The platform has already picked this session's variant (`{{ session.variant }}`) with the account preflight.
:::

::checks
