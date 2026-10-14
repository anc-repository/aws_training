---
step: enable-tls
---

:::method{kind=script default}
Preview the changes first (no API that changes resources is called):

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }} --dry-run
```

When you are happy with them, run it (if this account has a Route 53 hosted zone for the domain, add `--zone-id <ID>` and the validation records are created automatically):

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }}
```
:::

### ACME branch (variant `default`)

The script, in order: deploys the tls stack (ACME endpoint, pre-approved domain validation, issuer role `cloudalbum-{{ session.env }}-acme-issuer`) → prints the **domain validation CNAME** →
waits for it to become `VALID` → creates an EAB valid for 1 day → runs certbot on the lab instance through the delivery channel to register and issue (120-second client timeout) → deletes the EAB →
delivers `tls.env`, and hostSetup switches `/etc/cloudalbum/tls/server.*` to the new certificate and reloads Nginx.

:::wait{typical=5 max=30}
Add the CNAME the script printed to your DNS and **keep it there for good**: it is the persistent pre-approved validation, and deleting it makes new issuance and renewals fail.
**Why does port 80 not need to be open to the internet?** `PRE_APPROVED` domain validation is completed before the certificate is requested, so certbot faces no online challenge when it requests one;
Let's Encrypt's HTTP-01, by contrast, needs port 80 to be reachable.
:::

Confirm that Nginx switched certificates:

```bash {runsOn=lab}
openssl s_client -connect 127.0.0.1:443 </dev/null 2>/dev/null | openssl x509 -noout -issuer -ext subjectAltName -dates
```

:::expected
The issuer is Amazon, the SAN is `DNS:{{ learner.inputs.domain }}`, and validity is about 45 days. Opening `https://{{ learner.inputs.domain }}/` in the browser shows the padlock.
:::

### Fallback branch (variant `acme-off`)

The script deploys the tls-edge stack in **us-east-1** to request an integrated certificate (DNS validation) and injects the certificate and the alternate domain name into the cdn stack. Without a hosted zone, CloudFormation waits for validation:
in the ACM console (switch to US East (N. Virginia)), look up the validation CNAME and add it to your DNS. When it finishes, change `{{ learner.inputs.domain }}` from an A record to
a CNAME to the distribution's default domain name:

::console-link[Open this session's CloudFront distribution]{link=cloudfront.distribution distributionId="{{ envfile.cdn.CDN_DISTRIBUTION_ID }}"}

:::expected
The distribution's "Alternate domain name" is your domain and its "Custom SSL certificate" comes from us-east-1; `https://{{ learner.inputs.domain }}/` shows the padlock and the path header is `entry=cloudfront>nginx`.
Direct 443 on the lab instance is still self-signed — the ACM certificate only sits on CloudFront (the exam answer).
:::

::checks
