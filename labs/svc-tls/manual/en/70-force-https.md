---
step: force-https
---

(Optional, ACME branch) Redirect direct `http://` to `https://` and add HSTS. Start `max-age` small (300 seconds), and be sure to turn it off before the lab ends.

:::method{kind=script default}
Preview first, then run:

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }} --set TLS_FORCE_HTTPS=true --set TLS_HSTS_MAX_AGE=300 --dry-run
scripts/module enable tls --domain {{ learner.inputs.domain }} --set TLS_FORCE_HTTPS=true --set TLS_HSTS_MAX_AGE=300
```
:::

```bash {runsOn=workstation}
curl -sI http://{{ target.publicIp }}/ | grep -iE '^(HTTP|location)'
curl -sI https://{{ learner.inputs.domain }}/api/health/live | grep -i strict-transport
```

:::expected
The first returns `301` and `Location: https://…`; the second returns `Strict-Transport-Security: max-age=300`. The loopback address (the platform's local checks) and
`/.well-known/acme-challenge/` are not redirected.
:::

:::danger
Browsers remember HSTS for `max-age` seconds, and during that time refuse to go back to HTTP or a self-signed certificate. Turn it off before turning tls off:

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }} --set TLS_FORCE_HTTPS=false
```
:::

::checks
