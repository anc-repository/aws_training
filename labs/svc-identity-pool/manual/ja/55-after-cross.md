---
step: after-cross
---

もう一度権限外アクセスのテストを行います。A と B がそれぞれ認証情報を交換し、A が自分の ASIA の認証情報で B のプレフィックスに書き込む、バケット全体を一覧表示する、B のオブジェクトを削除する、を試します。

```bash {runsOn=workstation}
npm run exp -- identity-pool --label after --scenario cross-prefix --upload
```

::experiment{module=identity-pool id=cross-prefix label=after}

:::expected
`write-own` と `list-own` は allowed です。`write-other`、`list-root`、`delete-other` はいずれも S3 が返す 403 `AccessDenied` で、`deniedBy: s3` です。
`unexpected` = 0 です。サーバー側の証拠：A 自身のオブジェクトは存在し、B のプレフィックスに書き込もうとしたオブジェクトは存在せず、B のオブジェクトは削除されていません。
:::

:::why
今回の拒否は S3 で起きています。IAM はリクエスト者の ID に基づいて `${cognito-identity.amazonaws.com:sub}` を A の identityId に置き換え、それをリソースの ARN と比較します。
アプリのコードはまったく関与しません。これは、アプリにはこれらのリクエストが見えないということでもあります（S3 への直接アップロードのリクエストは Nginx も WAF も通りません）。監査が必要なら、CloudTrail の S3 データイベント（有料）を有効にする必要があります。
:::

::checks
