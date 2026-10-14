---
section: wrap-up
---

## What you did

- Migrated the local accounts into a Cognito User Pool: EC2 no longer stores password hashes, and AWS provides sign-up, verification, lockout and MFA.
- Read the public app client's settings and saw why writable attributes are the app's responsibility.
- Explained the issuer, signing algorithm and sign-out semantics of Cognito tokens.

## Exam points recap

- User Pool vs Identity Pool; ID, access and refresh tokens; authorization code + PKCE; public vs confidential clients.
- ALB `authenticate-cognito` only works on HTTPS listeners; JWT authorizers on API Gateway HTTP APIs.
- Lambda triggers (Pre Sign-up, Pre Token Generation, User Migration); social login and SAML federation; the certificate for a managed login custom domain lives in us-east-1.
- Stateless sessions are a prerequisite for scaling out with Auto Scaling; when to use Cognito vs IAM Identity Center; the shared responsibility model.
- Further reading: managed login (`COGNITO_LOGIN_MODE=managed`) needs a trusted HTTPS domain and is done in `sc-user-identity` with a CloudFront domain.
