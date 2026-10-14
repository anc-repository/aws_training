---
step: inspect-client
---

アプリクライアントを読み解きます。誰がどのフローでサインインできるか、トークンがどれだけの期間有効か、ユーザーがどの属性を書き換えられるかは、アプリクライアントで決まります。

```bash {runsOn=workstation}
aws cognito-idp describe-user-pool-client --user-pool-id "{{ var.userPoolId }}" --client-id "{{ var.clientId }}" --query "UserPoolClient.{Secret:ClientSecret,Flows:ExplicitAuthFlows,Access:AccessTokenValidity,Refresh:RefreshTokenValidity,Units:TokenValidityUnits,Read:ReadAttributes,Write:WriteAttributes}"
```

:::expected
`ClientSecret` はありません（パブリッククライアント）。認証フローは `ALLOW_USER_SRP_AUTH` と `ALLOW_REFRESH_TOKEN_AUTH` だけで、アクセストークンは 15 分、リフレッシュトークンは 30 日です。
読み取り可能な属性には `custom:plan` が含まれ、書き込み可能な属性は `email` だけです。
:::

:::why
**なぜパブリッククライアントなのでしょうか？** ブラウザーで動くコードは秘密を守れず、埋め込んだシークレットは公開したのと同じです。そのため SPA はパブリッククライアント＋ SRP（または認可コード＋ PKCE）を使います。
機密クライアントが向いているのはサーバー上で動く BFF だけで、その場合は Cognito の公開 API を呼ぶときに `SECRET_HASH` を付けます（参考：モジュールのドキュメントにある BFF の書き方）。
:::

:::saa{domain=secure confusable="公有客户端 vs 机密客户端"}
パブリッククライアント（SPA、モバイル）はシークレットを持てず、SRP または認可コード＋ PKCE を使います。機密クライアント（サーバー側）はシークレットを持てます。
ALB の `authenticate-cognito` には機密クライアントが必要で、HTTPS リスナーでしか使えません。
:::

::checks
