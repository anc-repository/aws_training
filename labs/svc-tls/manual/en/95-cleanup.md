---
section: cleanup
---

- The platform deletes the tls stack: deleting the ACME endpoint also deletes the EAB, the domain validation and the registered ACME account; the fallback branch's us-east-1 integrated certificate is deleted after it is detached from CloudFront.
- Optional: before the lab ends, revoke the still-valid ACME certificate on the lab instance (ACM's `RevokeCertificate` does not work on it): `scripts/module disable tls --param RevokeAcme=true`.
- The platform cannot delete the A record, validation CNAME (and the fallback branch's CNAME) you added in your own DNS; delete them yourself.
- If you turned on HSTS, browsers remember it for `max-age`: turn off `TLS_FORCE_HTTPS` before the lab ends.
- ACM deletes expired ACME certificates automatically after a year; use the ACME filter in the console to confirm nothing is left.
