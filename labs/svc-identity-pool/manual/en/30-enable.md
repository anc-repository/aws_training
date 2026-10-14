---
step: enable
---

Enable the Identity Pool. The module creates: the identity pool (no guest identities; its identity provider is the auth stack's User Pool client, passed in through the registry's injects),
the authenticated role `cloudalbum-<env>-identity-pool-uploader` ("CloudAlbumUploaderRole" in the module docs), and the staging bucket
`cloudalbum-<env>-upload-staging-<account>` (CORS exposes ETag, objects under `private/` expire after 1 day, unfinished multipart uploads are aborted after 1 day, no event notifications).

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable identity-pool --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable identity-pool
```
:::

:::wait{typical=3 max=15}
Deploying the identity pool, role and staging bucket usually takes a minute or two, then `identity-pool.env` is written and api restarts. For the first minute or two after the restart, the first probe may be slow,
and a brief yellow status is normal.
:::

When it is done, upload two photos at once in the app preview and look at DevTools:

- `GET /api/uploads/credentials` returns `accessKeyId` (`ASIA…`), `expiration`, `identityId` and `prefix=private/<identityId>/`;
- part requests go straight to `…upload-staging-….s3.ap-northeast-1.amazonaws.com`, with no requests to EC2 in between;
- the `X-CloudAlbum-Path` response header of `POST /api/photos/<id>/complete` contains `identity-pool=cognito:sts` and `storage=s3:import`.

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules["identity-pool"] | {driver, status, detail}'
```

:::expected
identity-pool is "Healthy (with the expected warning DEP-030)" or "Healthy", with driver `cognito`; the identity pool allows no guest identities, and the authenticated role is the Uploader role.
:::

:::saa{domain=secure confusable="User Pool vs Identity Pool"}
A JWT issued by the User Pool cannot call AWS APIs directly; the Identity Pool exchanges it for an IAM role's temporary credentials. While they are valid (about an hour; see the official docs) they
can make any number of requests, limited by the role's policy — unlike a presigned URL, which covers one request.
:::

::checks
