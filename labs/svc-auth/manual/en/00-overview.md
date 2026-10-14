---
section: overview
---

## Background

At L0, EC2 implements all of sign-in itself: argon2id password hashing, ES256 JWTs, email verification, lockout, password reset and optional TOTP. Every piece is code we write, maintain and carry the risk for.
Once Amazon Cognito User Pool is enabled, passwords and the authentication flow move to AWS: the browser talks to the User Pool directly through Amplify, and EC2 never handles passwords —
it only verifies access tokens locally with the JWKS that the User Pool publishes.

:::why
**Authentication is outsourced; responsibility is not — at least not all of it.** AWS takes care of password hashing, lockout and MFA. But which attributes the app client lets users rewrite, which claims we check when validating tokens,
and how long an old token keeps working after sign-out are still our design decisions (the shared responsibility model).
:::

## Comparison experiments

### Feature matrix and brute force (auth/feature-matrix, auth/brute-force; before is required)

- **Without Cognito (local)**: the feature matrix lists the locally implemented sign-up, verification, lockout and TOTP; repeated wrong passwords produce 401 → 423 (locked) / 429 (rate limited).
- **With Cognito**: MFA, password reset, temporary lockout and federated sign-in all come from the User Pool, and Cognito signs the tokens with RS256.
- **Where you will see it**: the before experiment report; `/api/capabilities` and the probe endpoint after enabling; the User Pool and app client settings.
- **Note**: in this version the after side is compared through checks and observation (the experiment script's Cognito sign-in needs `USER_PASSWORD_AUTH`, but this module's client only allows SRP).

## Platform mode notes

When you enable Cognito, `scripts/module` runs the `cognito-passwords` hook once on the workbench as you, which marks the test accounts prepared in the start state as confirmed with known passwords.
The passwords are kept only in platform parameters and never appear in the manual or in check evidence. To sign up a new account you need an email address you can receive mail at: Cognito really sends the verification code.
