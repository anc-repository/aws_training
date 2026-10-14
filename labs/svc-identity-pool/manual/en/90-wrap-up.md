---
section: wrap-up
---

## What you did

- Moved F14's authorization from "application code checks a prefix token for every part" to "an IAM policy variable enforced in S3": the browser holds STS temporary credentials that can only write its own prefix and sends the parts straight to the staging bucket.
- Saw two kinds of denial in the cross-prefix experiment: the app's 403 `UPLOAD_PREFIX_DENIED` and S3's `AccessDenied`.
- Quantified backend requests: they grow linearly with the number of parts with prefix tokens, and only depend on the number of files with temporary credentials.
- Read the authenticated role's trust policy (aud, amr) and permissions policy (`${cognito-identity.amazonaws.com:sub}`), and saw the cost of importing with a server-side CopyObject.

## Exam points recap

- How the User Pool and Identity Pool divide the work; web identity federation and `AssumeRoleWithWebIdentity`; developer-authenticated identities (`GetOpenIdTokenForDeveloperIdentity` when auth=local).
- The policy variable `${cognito-identity.amazonaws.com:sub}` is the Identity ID, not the User Pool sub; the `aud` and `amr` conditions in the trust policy; the risk of guest identities.
- Trade-offs between presigned URLs, app-signed tokens and temporary credentials: where authorization happens, how many requests, how to revoke, how much server-side control.
- S3 CORS must expose `ETag`; multipart uploads and lifecycle rules that clean up unfinished parts; with SSE-KMS, multipart uploads also need `kms:Decrypt`.
