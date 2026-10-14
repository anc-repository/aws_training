---
step: before-features
---

Record the before: read auth's public settings and the F1–F4 and F12 sub-features from `/api/capabilities`, and build a feature matrix.

```bash {runsOn=workstation}
npm run exp -- auth --label before --scenario feature-matrix --upload
```

::experiment{module=auth id=feature-matrix label=before}

Then look at the local driver's signing public key (published by EC2 while auth=local):

```bash {runsOn=lab}
curl -s http://127.0.0.1/.well-known/jwks.json | jq ".keys[] | {kid, kty, crv, alg}"
```

:::expected
In the feature matrix, sign-up, email verification, lockout and TOTP are all implemented by `local`; the key in the JWKS is an EC key on curve P-256 with `alg` `ES256`.
:::

::checks
