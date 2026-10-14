---
step: read-policy
---

Uploader ロールを読み解きます。

:::method{kind=console default}
::console-link[IAM コンソールで Uploader ロールを開く]{link=iam.role roleName="{{ var.uploaderRoleName }}"}

1. **信頼関係**：プリンシパルは `cognito-identity.amazonaws.com`、アクションは `sts:AssumeRoleWithWebIdentity` です。条件には
   `cognito-identity.amazonaws.com:aud`（この Identity Pool の ID `{{ var.identityPoolId }}` と等しい）と `cognito-identity.amazonaws.com:amr`（`authenticated`）の両方があります。
2. **許可 → staging-own-prefix**：`s3:PutObject`、`s3:AbortMultipartUpload`、`s3:ListMultipartUploadParts` のリソースは
   `arn:aws:s3:::{{ var.stagingBucket }}/private/${cognito-identity.amazonaws.com:sub}/*` です。`s3:ListBucket` は `s3:prefix` が同じプレフィックスに一致するときだけ許可されます。
3. IAM Policy Simulator を開いてこのロールを選び、サービスに S3、アクションに `PutObject` を指定します。リソースに自分の identityId のプレフィックスを入れ、コンテキストキー
   `cognito-identity.amazonaws.com:sub` に同じ identityId を設定すると allowed、リソースを他人の identityId に変えると implicitDeny になります。
   自分の identityId は、`/lab` の identity-pool カード（管理者ビュー）か、前のステップの DevTools にある `/api/uploads/credentials` のレスポンスで確認できます。
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws iam get-role --role-name "{{ var.uploaderRoleName }}" --query Role.AssumeRolePolicyDocument
aws iam get-role-policy --role-name "{{ var.uploaderRoleName }}" --policy-name staging-own-prefix
aws s3api get-bucket-cors --bucket "{{ var.stagingBucket }}"
```
:::

::console-link[S3 コンソールでステージングバケットを開く]{link=s3.bucket bucket="{{ var.stagingBucket }}"}

:::why
- `aud` の条件がない場合：どの Identity Pool（他人のアカウントのものも含む）で交換したトークンでも、このロールを引き受けられるおそれがあります。
- `amr` の条件がない場合：未認証（ゲスト）ID でも引き受けられるおそれがあります。
- IAM ではオブジェクトのサイズや種類を制御できません。これらは `complete` の時点でバックエンドが検証し、基準を満たさなければステージングのオブジェクトを削除して写真を失敗としてマークします。complete が呼ばれなかったオブジェクトは 1 日で期限切れになります。
- ステージングバケットを SSE-KMS に変える場合、マルチパートアップロードには `kms:GenerateDataKey` に加えて `kms:Decrypt` も必要です（S3 が各パートを復号しないと結合できないため）。テンプレートは `KmsKeyArn` が空でないときに両方のロールにこれを追加します。
:::

::checks
