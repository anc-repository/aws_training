---
step: two-columns
---

In the ACM console's certificate list, filter by "Key pair origin: ACME" (without the filter ACME certificates are hidden by default) and look at this certificate's origin and renewal method.

| | The exam answer (the usual answer in SAA question banks) | The 2026 capability (this card's ACME branch) |
|---|---|---|
| Can an ACM certificate be installed on EC2 | **No**: the private key is managed by ACM and not exportable; it only attaches to CloudFront, ALB and API Gateway | The ACME endpoint issues a 45-day certificate whose private key lives on the instance, installed in Nginx |
| Renewal | Managed automatically by ACM (the DNS validation record must stay) | Renewed by the client (a certbot timer); ACM is not responsible |
| Can it attach to CloudFront / ALB | Yes (CloudFront uses certificates in us-east-1) | **No** |

:::expected
The ACME certificate's "Key pair origin" is ACME and it has no "managed renewal"; it cannot be chosen as a CloudFront distribution's custom certificate.
:::

:::saa{domain=secure}
Answer with the left column: the standard answer to "terminate TLS on EC2 with an ACM certificate" is to put an ALB / CloudFront in front, or to import a third-party certificate.
:::

::checks
