---
step: enable
---

Identity Pool を有効にします。モジュールは次のものを作成します。Identity Pool（ゲスト ID を許可せず、ID プロバイダーは auth スタックの User Pool クライアントで、registry の injects から渡されます）、
認証済みロール `cloudalbum-<env>-identity-pool-uploader`（モジュールのドキュメントでいう「CloudAlbumUploaderRole」）、ステージングバケット
`cloudalbum-<env>-upload-staging-<アカウント>`（CORS で ETag を公開、`private/` 以下は 1 日で期限切れ、未完了のマルチパートアップロードは 1 日後に中止、イベント通知は設定しない）です。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable identity-pool --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable identity-pool
```
:::

:::wait{typical=3 max=15}
Identity Pool、ロール、ステージングバケットのデプロイには通常 1～2 分かかり、その後 `identity-pool.env` を書き込んで api を再起動します。再起動直後の 1～2 分は最初のプローブが遅いことがあり、
状態が一時的に黄色になるのは正常です。
:::

完了したら、アプリのプレビューで写真を 2 枚まとめてアップロードし、DevTools を見ます。

- `GET /api/uploads/credentials` が `accessKeyId`（`ASIA…`）、`expiration`、`identityId`、`prefix=private/<identityId>/` を返します。
- パートのリクエストは `…upload-staging-….s3.ap-northeast-1.amazonaws.com` に直接届き、途中に EC2 へのリクエストはありません。
- `POST /api/photos/<id>/complete` のレスポンスヘッダー `X-CloudAlbum-Path` には `identity-pool=cognito:sts` と `storage=s3:import` が含まれます。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules["identity-pool"] | {driver, status, detail}'
```

:::expected
identity-pool は「正常（想定内の警告 DEP-030 を含む）」または「正常」で、driver は `cognito` です。Identity Pool はゲスト ID を許可せず、認証済みロールは Uploader ロールです。
:::

:::saa{domain=secure confusable="User Pool vs Identity Pool"}
User Pool が発行する JWT では AWS API を直接呼び出せません。Identity Pool がそれを IAM ロールの一時的な認証情報に交換します。認証情報は有効期間内（約 1 時間。公式ドキュメントを確認してください）なら
何回でもリクエストでき、範囲はロールのポリシーで制限されます。これは「リクエストごとに 1 つ」の署名付き URL とは異なります。
:::

::checks
