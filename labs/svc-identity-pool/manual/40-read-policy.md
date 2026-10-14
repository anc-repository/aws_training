---
step: read-policy
---

读懂 Uploader 角色。

:::method{kind=console default}
::console-link[在 IAM 控制台打开 Uploader 角色]{link=iam.role roleName="{{ var.uploaderRoleName }}"}

1. **信任关系**：主体是 `cognito-identity.amazonaws.com`，动作是 `sts:AssumeRoleWithWebIdentity`；条件同时有
   `cognito-identity.amazonaws.com:aud`（等于本身份池 ID `{{ var.identityPoolId }}`）与 `cognito-identity.amazonaws.com:amr`（`authenticated`）。
2. **权限 → staging-own-prefix**：`s3:PutObject`、`s3:AbortMultipartUpload`、`s3:ListMultipartUploadParts` 的资源是
   `arn:aws:s3:::{{ var.stagingBucket }}/private/${cognito-identity.amazonaws.com:sub}/*`；`s3:ListBucket` 只在 `s3:prefix` 匹配同一前缀时允许。
3. 打开 IAM Policy Simulator，选择这个角色，服务选 S3、操作 `PutObject`：资源填你自己的 identityId 前缀，并把上下文键
   `cognito-identity.amazonaws.com:sub` 设为同一个 identityId → allowed；资源换成别人的 identityId → implicitDeny。
   你的 identityId 可以在 `/lab` 的 identity-pool 卡片里看到（管理员视图），或在上一步 DevTools 的 `/api/uploads/credentials` 响应里。
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws iam get-role --role-name "{{ var.uploaderRoleName }}" --query Role.AssumeRolePolicyDocument
aws iam get-role-policy --role-name "{{ var.uploaderRoleName }}" --policy-name staging-own-prefix
aws s3api get-bucket-cors --bucket "{{ var.stagingBucket }}"
```
:::

::console-link[在 S3 控制台打开暂存桶]{link=s3.bucket bucket="{{ var.stagingBucket }}"}

:::why
- 没有 `aud` 条件：任何身份池（包括别人账号里的）换来的令牌都可能扮演这个角色。
- 没有 `amr` 条件：未认证（访客）身份也可能扮演。
- IAM 管不了对象的大小与类型：这些在 `complete` 时由后端校验，不合规就删除暂存对象并把照片标记为失败；没调用 complete 的对象 1 天后过期。
- 暂存桶若改用 SSE-KMS，分片上传除了 `kms:GenerateDataKey` 还需要 `kms:Decrypt`（S3 要解密各分片才能合并），模板在 `KmsKeyArn` 非空时给两个角色都加上。
:::

::checks
