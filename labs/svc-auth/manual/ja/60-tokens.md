---
step: tokens
---

トークンは今では User Pool が発行しています。発行者と署名用の公開鍵を見てみましょう。

```bash {runsOn=workstation}
curl -s "{{ var.issuer }}/.well-known/openid-configuration" | jq "{issuer, jwks_uri}"
curl -s "{{ var.issuer }}/.well-known/jwks.json" | jq ".keys[] | {kid, kty, alg}"
```

ローカルドライバーの JWKS はもう公開されていません。

```bash {runsOn=lab}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1/.well-known/jwks.json
```

:::expected
発行者は `https://cognito-idp.{{ session.region }}.amazonaws.com/<User Pool ID>` です。JWKS のキーは RSA で、`alg` は `RS256` です。EC2 上の JWKS は 404 を返します。
:::

:::why
**ローカルで検証する代償**：バックエンドは JWKS でアクセストークンの署名、`exp`、`token_use=access`、`client_id` を検証するだけで、毎回 Cognito に問い合わせることはしません。
そのため、ユーザーがサインアウト（GlobalSignOut）すると、リフレッシュトークンはすぐに無効になりますが、発行済みのアクセストークンは有効期限（このカードでは 15 分）まで使えます。
ローカルドライバーは、リクエストのたびにトークンのバージョン番号（`tv`）を照合することで「サインアウトしたら即無効」を実現していました。その代わり、毎回データベースを参照する必要があります。
:::

:::saa{domain=secure confusable="ID token vs access token"}
ID トークンは「ユーザーが誰か」を表します（フロントエンドでの表示用）。アクセストークンは API の呼び出しに使います（`token_use=access`、`scope` と `cognito:groups` を含む）。
リフレッシュトークンは新しい ID / アクセストークンを取得するためのもので、取り消すことができます。
:::

::checks
