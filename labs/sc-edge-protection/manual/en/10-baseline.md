---
step: baseline
---

First, get a clear view of the starting point: `waf` is Nginx on the instance (`WAF_MODE=nginx`), `cdn` is not enabled, and both browsers and attackers hit the lab instance's Elastic IP directly.

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules | {waf: .waf.driver, cdn: .cdn.driver}'
```

Record the first part of **before**: a short round of rate-limit attack from the workbench against the direct entry. The runner sends `POST /api/auth/login` (anonymous, wrong password) at slightly above the threshold,
records the status code every second, and then reads this run's nonce count from the origin log as an admin.

```bash {runsOn=workstation}
npm run exp:login -w @cloudalbum/experiments
npm run exp -- waf --label before --scenario flood --param target=direct --param rate=8 --param duration=30 --upload
```

::experiment{module=waf id=flood label=before}

:::tip
`WAF_LAB_ALLOW_CIDR` must be empty — it is an Allow action that lets allow-listed addresses skip every rule. This card never sets it.
:::

:::expected
Nginx's `limit_req` blocks with **429** almost immediately (path header `waf=nginx:ratelimit`), but every sign-in request of this round shows up in the lab instance's access log:
refused requests used the instance's connections, TLS and logging just the same.
:::

:::why
**"Stopped" is not "never arrived".** Before Nginx refuses a request, the TCP handshake, TLS decryption and request parsing have already happened on EC2; with a bit more attack volume,
Nginx itself becomes the bottleneck. This card moves the blocking point to the CloudFront edge so these requests never even enter the Tokyo Region.
:::

::checks
