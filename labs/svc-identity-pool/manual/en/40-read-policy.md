---
step: read-policy
---

Read the Uploader role.

:::method{kind=console default}
::console-link[Open the Uploader role in the IAM console]{link=iam.role roleName="{{ var.uploaderRoleName }}"}

1. **Trust relationships**: the principal is `cognito-identity.amazonaws.com` and the action is `sts:AssumeRoleWithWebIdentity`; the conditions include both
   `cognito-identity.amazonaws.com:aud` (equal to this identity pool's ID `{{ var.identityPoolId }}`) and `cognito-identity.amazonaws.com:amr` (`authenticated`).
2. **Permissions → staging-own-prefix**: the resource of `s3:PutObject`, `s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts` is
   `arn:aws:s3:::{{ var.stagingBucket }}/private/${cognito-identity.amazonaws.com:sub}/*`; `s3:ListBucket` is only allowed when `s3:prefix` matches the same prefix.
3. Open the IAM Policy Simulator, select this role, choose the S3 service and the `PutObject` action: with your own identityId prefix as the resource and the context key
   `cognito-identity.amazonaws.com:sub` set to the same identityId → allowed; with someone else's identityId as the resource → implicitDeny.
   You can find your identityId on the identity-pool card on `/lab` (admin view), or in the `/api/uploads/credentials` response in DevTools from the previous step.
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws iam get-role --role-name "{{ var.uploaderRoleName }}" --query Role.AssumeRolePolicyDocument
aws iam get-role-policy --role-name "{{ var.uploaderRoleName }}" --policy-name staging-own-prefix
aws s3api get-bucket-cors --bucket "{{ var.stagingBucket }}"
```
:::

::console-link[Open the staging bucket in the S3 console]{link=s3.bucket bucket="{{ var.stagingBucket }}"}

:::why
- Without an `aud` condition, tokens exchanged through any identity pool (including ones in other people's accounts) might assume this role.
- Without an `amr` condition, unauthenticated (guest) identities might assume it too.
- IAM cannot govern object size and type: the backend checks those on `complete`, deleting the staging object and marking the photo as failed if they do not pass; objects that never get a complete expire after 1 day.
- If the staging bucket switched to SSE-KMS, multipart uploads would need `kms:Decrypt` in addition to `kms:GenerateDataKey` (S3 has to decrypt the parts to merge them); the template adds both to the two roles when `KmsKeyArn` is not empty.
:::

::checks
