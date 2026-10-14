---
section: overview
---

## Background

CloudAlbum's F14 is "multi-file, resumable, prefix-authorized direct upload". In the start state (identity-pool's none driver), EC2 issues its own
**prefix-scoped upload token**: the browser holds one token and can upload several files in a row under `raw/<userId>/` and resume part by part, but it has to ask EC2 before every part —
in this card's start state storage is already S3, so each part first calls `POST /api/uploads/parts:sign` to get a presigned `UploadPart` URL, and the authorization logic lives in application code.

Once the Identity Pool is enabled, a signed-in user exchanges the User Pool ID token for STS temporary credentials (the access key starts with `ASIA`)
that can only write to `private/<identityId>/` in the module's own staging bucket. The browser signs the parts itself and sends them straight to S3; on `complete` the backend checks size, type and
file header (magic number) and then imports the object into the original image location with a server-side `CopyObject` — after that, thumbnails and tagging work exactly as for any other upload.

:::why
The User Pool answers "who are you" (it issues JWTs); the Identity Pool answers "what can you do in AWS": it exchanges the User Pool token for an IAM role's temporary credentials
(web identity federation, with `sts:AssumeRoleWithWebIdentity` underneath). One role is shared by every user, yet each user is confined to their own prefix,
thanks to the IAM policy variable `${cognito-identity.amazonaws.com:sub}` — whose value is the Identity ID (like `ap-northeast-1:uuid`), not the User Pool sub.
:::

## Comparison experiments

### Batch upload (identity-pool/upload-bench, required)

- **Without the Identity Pool**: each file = create + **one** `parts:sign` **per part** + complete, so backend requests grow linearly with the number of parts.
- **With the Identity Pool**: after one credential exchange, each file only needs two backend requests, create and complete; every part request goes straight to S3.
- **Where you will see it**: `backendRequestsPerFile` in the report; in the browser's DevTools, sts-mode requests go straight to
  `cloudalbum-<env>-upload-staging-<account>.s3.ap-northeast-1.amazonaws.com` with an `x-amz-security-token` request header, and the Credential in Authorization starts with `ASIA`.

### Cross-prefix test (identity-pool/cross-prefix, required)

User A writes to B's prefix, lists the whole bucket and deletes B's object: both approaches deny it, but **someone different does the denying** — in before the app returns 403 `UPLOAD_PREFIX_DENIED`,
in after S3 returns `AccessDenied` and application code is not involved at all.

### Resumable upload (identity-pool/resume, required)

Interrupt an upload halfway and resume: S3's `ListParts` tells the browser which parts already arrived, and only the missing ones are sent again.

## Before you start

- The start state already includes storage (S3), auth (Cognito) and two confirmed test users with known passwords (seed `cognito-test-users`).
  The comparison experiments read them from the workbench (the SecureString that the environment variable `CLOUDALBUM_TEST_USERS_PARAM` points to), and the passwords are only used in local process memory.
- Expected warnings: `DEP-013` (auth=cognito together with L0's local outbox) and `DEP-030` (while APP_BASE_URL is http, temporary credentials are handed out in clear text;
  the platform's preview option B has the browser use `https://<EIP>`). The yellow status is by design, and the checks judge it against the expected warnings.

## Platform mode notes

`scripts/module` and the comparison experiments run in the workbench terminal as the learner identity; the Uploader role carries the workload permissions boundary (ATLWorkloadBoundary).
Besides `http://<EIP>`, the staging bucket's CORS also allows `https://<EIP>`, which the preview uses.
