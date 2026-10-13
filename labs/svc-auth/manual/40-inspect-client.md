---
step: inspect-client
---

看懂应用客户端：它决定了谁能用哪些流程登录、令牌有效多久、用户能改写哪些属性。

```bash {runsOn=workstation}
aws cognito-idp describe-user-pool-client --user-pool-id "{{ var.userPoolId }}" --client-id "{{ var.clientId }}" --query "UserPoolClient.{Secret:ClientSecret,Flows:ExplicitAuthFlows,Access:AccessTokenValidity,Refresh:RefreshTokenValidity,Units:TokenValidityUnits,Read:ReadAttributes,Write:WriteAttributes}"
```

:::expected
没有 `ClientSecret`（公有客户端）；认证流程只有 `ALLOW_USER_SRP_AUTH` 与 `ALLOW_REFRESH_TOKEN_AUTH`；access token 15 分钟、refresh token 30 天；
可读属性包括 `custom:plan`，可写属性只有 `email`。
:::

:::why
**为什么是公有客户端？** 浏览器里的代码无法保密，放进去的密钥等于公开；所以 SPA 用公有客户端 + SRP（或授权码 + PKCE）。
只有运行在服务器上的 BFF 才适合机密客户端，那时调用 Cognito 的公开 API 要带 `SECRET_HASH`（选读：模块文档的 BFF 写法）。
:::

:::saa{domain=secure confusable="公有客户端 vs 机密客户端"}
公有客户端（SPA、移动端）不能有密钥，用 SRP 或授权码 + PKCE；机密客户端（服务器端）可以有密钥。
ALB 的 `authenticate-cognito` 需要机密客户端，且只能用于 HTTPS 监听器。
:::

::checks
