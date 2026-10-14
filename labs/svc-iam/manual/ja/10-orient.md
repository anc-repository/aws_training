---
step: orient
---

**ラボ用インスタンスのターミナル**で、IMDSv2 を使ってインスタンスロールの名前を読み取ります（名前だけを見て、認証情報は表示しません）。

```bash {runsOn=lab}
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/; echo
```

次に、アプリ自身の認証情報の設定を見ます。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq ".modules.iam | {driver, status, detail}"
```

:::expected
IMDS はロール名 `CloudAlbumAppRole` を返します。アプリの iam ドライバーは `none`、状態は `off` です。インスタンスにはロールがあるのに、アプリはそれを使っていません。
:::

:::danger
`iam/security-credentials/CloudAlbumAppRole` にはリクエストしないでください。一時的な認証情報がターミナルとコマンド履歴に表示されてしまいます。
:::

::checks
