---
step: inspect-client
---

Read the app client: it decides who can sign in with which flows, how long tokens stay valid and which attributes users can rewrite.

```bash {runsOn=workstation}
aws cognito-idp describe-user-pool-client --user-pool-id "{{ var.userPoolId }}" --client-id "{{ var.clientId }}" --query "UserPoolClient.{Secret:ClientSecret,Flows:ExplicitAuthFlows,Access:AccessTokenValidity,Refresh:RefreshTokenValidity,Units:TokenValidityUnits,Read:ReadAttributes,Write:WriteAttributes}"
```

:::expected
There is no `ClientSecret` (a public client); the only auth flows are `ALLOW_USER_SRP_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH`; access tokens last 15 minutes and refresh tokens 30 days;
the readable attributes include `custom:plan`, and the only writable attribute is `email`.
:::

:::why
**Why a public client?** Code running in a browser cannot keep a secret — any secret you put there is effectively public. So an SPA uses a public client with SRP (or authorization code + PKCE).
Only a BFF running on a server is a good fit for a confidential client, and then calls to Cognito's public APIs must include a `SECRET_HASH` (further reading: the BFF pattern in the module docs).
:::

:::saa{domain=secure confusable="公有客户端 vs 机密客户端"}
Public clients (SPAs, mobile apps) cannot have a secret and use SRP or authorization code + PKCE; confidential clients (server side) can have one.
The ALB's `authenticate-cognito` needs a confidential client and only works on an HTTPS listener.
:::

::checks
