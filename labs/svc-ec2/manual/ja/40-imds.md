---
step: imds
---

サーバーに GET リクエストを代わりに送らせることしかできない SSRF を再現します。セッショントークンなしで直接メタデータを読んでみます。

```bash {runsOn=lab}
curl -s -o /dev/null -w "without token: %{http_code}\n" http://169.254.169.254/latest/meta-data/instance-id
```

正しい手順では、まず PUT でセッショントークンを取得し、そのトークンを付けて読み取ります。

```bash {runsOn=lab}
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id; echo
```

:::expected
トークンなしのリクエストは `401` を返し、トークンありのリクエストはインスタンス ID を返します。
:::

:::why
IMDSv2 には関門が 2 つあります。トークンの取得には `PUT` と特定のリクエストヘッダーが必要で、典型的な SSRF ではサーバーに GET しか送らせられません。さらにトークンのレスポンスのホップ数制限（ここでは 1）により、トークンはインスタンスの外に出られません。
インスタンスメタデータサービスはインスタンスローカルのリンクローカルアドレスなので、セキュリティグループでも NACL でも制御できません。
:::

::checks
