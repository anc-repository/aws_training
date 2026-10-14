---
step: baseline-payloads
---

Record the second part of **before**: Nginx's signature blocking. `payloads` sends a set of public WAF test payloads to the direct entry — SQL injection with its URL-encoded,
double-encoded and case-and-comment variants, directory traversal, XSS, a Log4Shell probe string in a request header, and scanner User-Agents.

```bash {runsOn=workstation}
npm run exp -- waf --label before --scenario payloads --param target=direct --upload
```

::experiment{module=waf id=payloads label=before}

Look at the rules Nginx uses on the lab instance:

```bash {runsOn=lab}
grep -n 'ca_block' -A3 /etc/nginx/conf.d/cloudalbum.conf | head -8
```

:::expected
The most obvious `union select`, `<script` and `../` are blocked by Nginx with 403; double-encoded variants and mixed-case variants with comments go straight through to the app.
These misses are compared with the AWS managed rule groups in step 9.
:::

::checks
