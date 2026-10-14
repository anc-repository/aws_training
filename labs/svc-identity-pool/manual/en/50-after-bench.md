---
step: after-bench
---

The same test user and the same 10 files, this time uploaded straight to the staging bucket with STS temporary credentials.

```bash {runsOn=workstation}
npm run exp -- identity-pool --label after --scenario upload-bench --upload
npm run exp:report -- identity-pool --experiment upload-bench
```

::experiment{module=identity-pool id=upload-bench label=after}

:::expected
`mode=sts`, and `backendRequestsPerFile` is about 2 (create and complete, plus one credential exchange for the whole batch), regardless of the number of parts; `s3RequestsPerFile` = number of parts + 2
(CreateMultipartUpload, UploadPart × n, CompleteMultipartUpload). Server-side evidence: every photo is already `PROCESSING` / `READY` on the server,
and the sampled staging objects were deleted after complete (DeleteObject after the server-side CopyObject).
:::

:::tip
Inbound traffic to EC2 is only metadata on both sides: in this card's start state storage is already S3, so the before parts also went straight to S3 — they just asked EC2 first for every part.
For a baseline where the bytes pass through EC2, run `--label before --param mode=token` separately on an L0 with storage=local (further reading).
:::

::checks
