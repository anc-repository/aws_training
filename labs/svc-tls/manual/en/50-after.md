---
step: after
---

Measure again the same way as before:

```bash {runsOn=workstation}
npm run exp -- tls --label after --scenario inspect --upload
```

::experiment{module=tls id=inspect label=after}

:::expected
The number of trusted entry points (`trustedEntries`) goes up: in the ACME branch the direct entry is now issued by Amazon; in the fallback branch the CloudFront alternate domain name uses the us-east-1 integrated certificate.
The report marks before and after as a comparable pair.
:::

**ACME branch: renewal drill.** At 5 s, `certbot renew --dry-run` runs on the lab instance, then `--force-renewal` (one more issuance, billed per domain):

```bash {runsOn=workstation}
npm run exp -- tls --label after --scenario renew-drill --fault-via ssm --upload
```

::experiment{module=tls id=renew-drill label=after}

:::expected
`renewed` is true and `secondsToNewCert` is around two minutes: the new certificate (with a new serial number) really went into Nginx. Look in the ACM console with the ACME filter:
the certificate ARN has not changed (same ACME account, same domain and key algorithm).
:::

:::tip
Optional: run `--scenario handshake` in CloudShell in 4 Regions to compare TLS handshake times through CloudFront and direct; `--scenario cipher-scan` needs nmap.
:::

::checks
