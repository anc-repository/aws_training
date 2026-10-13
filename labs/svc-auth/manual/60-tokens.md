---
step: tokens
---

令牌现在由 User Pool 签发。看看它的签发者与签名公钥：

```bash {runsOn=workstation}
curl -s "{{ var.issuer }}/.well-known/openid-configuration" | jq "{issuer, jwks_uri}"
curl -s "{{ var.issuer }}/.well-known/jwks.json" | jq ".keys[] | {kid, kty, alg}"
```

本地驱动的 JWKS 已经不再发布：

```bash {runsOn=lab}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1/.well-known/jwks.json
```

:::expected
签发者是 `https://cognito-idp.{{ session.region }}.amazonaws.com/<User Pool ID>`；JWKS 中的密钥是 RSA，`alg` 为 `RS256`；EC2 上的 JWKS 返回 404。
:::

:::why
**本地验签的代价**：后端只用 JWKS 校验 access token 的签名、`exp`、`token_use=access` 与 `client_id`，不会每次询问 Cognito。
所以用户登出（GlobalSignOut）后，refresh token 立即失效，但已经签发的 access token 在过期前（本卡 15 分钟）仍然有效。
本地驱动用令牌版本号（`tv`）在每次请求时比对，才做到“登出立即失效”——代价是每次请求都要查库。
:::

:::saa{domain=secure confusable="ID token vs access token"}
ID token 描述“用户是谁”（给前端展示）；access token 用于调用 API（`token_use=access`、带 `scope` 与 `cognito:groups`）；
refresh token 用来换新的 ID / access token，可以被吊销。
:::

::checks
