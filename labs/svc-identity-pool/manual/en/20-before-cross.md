---
step: before-cross
---

Cross-prefix test: test user A takes their own prefix token and tries to write to B's original image key and delete B's photo (with storage=local it also tries to list B's parts).

```bash {runsOn=workstation}
npm run exp -- identity-pool --label before --scenario cross-prefix --upload
```

::experiment{module=identity-pool id=cross-prefix label=before}

:::expected
In `attempts`, `write-own` is allowed and `write-other` is 403 `UPLOAD_PREFIX_DENIED` with `deniedBy: application`;
`deniedByApplication` ≥ 2 and `unexpected` = 0. The server-side evidence `otherPhotoStatus` is `UPLOADING`: nothing was written to B's photo.
:::

:::why
The denial logic is in `backend/src/adapters/identity-pool/none.ts`: a key must both be inside the token's prefix and belong to a photo owned by the token holder that is still uploading.
That is the application code's job — get one line wrong and cross-prefix access goes through. The next step hands this job to IAM.
:::

::checks
