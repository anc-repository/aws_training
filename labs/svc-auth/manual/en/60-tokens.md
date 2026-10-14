---
step: tokens
---

Tokens are now issued by the User Pool. Look at its issuer and signing public keys:

```bash {runsOn=workstation}
curl -s "{{ var.issuer }}/.well-known/openid-configuration" | jq "{issuer, jwks_uri}"
curl -s "{{ var.issuer }}/.well-known/jwks.json" | jq ".keys[] | {kid, kty, alg}"
```

The local driver's JWKS is no longer published:

```bash {runsOn=lab}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1/.well-known/jwks.json
```

:::expected
The issuer is `https://cognito-idp.{{ session.region }}.amazonaws.com/<User Pool ID>`; the key in the JWKS is RSA with `alg` `RS256`; the JWKS on EC2 returns 404.
:::

:::why
**The cost of local verification**: the backend only uses the JWKS to check the access token's signature, `exp`, `token_use=access` and `client_id`; it does not ask Cognito on every request.
So when a user signs out (GlobalSignOut), the refresh token stops working immediately, but access tokens that were already issued stay valid until they expire (15 minutes in this card).
The local driver compared a token version number (`tv`) on every request to make sign-out take effect immediately — at the price of a database lookup per request.
:::

:::saa{domain=secure confusable="ID token vs access token"}
The ID token describes who the user is (for display in the front end); the access token is for calling APIs (`token_use=access`, with `scope` and `cognito:groups`);
the refresh token gets new ID / access tokens and can be revoked.
:::

::checks
