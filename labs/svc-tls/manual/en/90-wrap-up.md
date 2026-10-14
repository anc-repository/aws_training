---
section: wrap-up
---

## What you did

- Went from a self-signed certificate to a trusted ACM certificate: installed in Nginx in the ACME branch, attached to CloudFront in the fallback branch (with the certificate in us-east-1).
- Confirmed with server-side evidence (a handshake on the lab instance itself, the platform checking the certificate SAN when reaching your domain, the certificate in ACM's control plane) that the certificate really took effect.
- Told "the exam answer" from "the 2026 capability".

## Exam points recap

- ACM public certificates are free and auto-renewed when used with integrated services, and their private keys cannot be exported; DNS vs email validation; validation records must stay for renewal.
- Certificate Regions: CloudFront and Cognito managed login custom domains use us-east-1; ALBs and Regional API Gateway use the resource's Region.
- Imported certificates are renewed manually; ACM Private CA is for internal certificates.
- SNI and multiple certificates on one listener; an ALB can re-encrypt to its targets, but does not validate the target's certificate.
- HSTS; terminating TLS at the edge reduces handshake latency for distant users.
