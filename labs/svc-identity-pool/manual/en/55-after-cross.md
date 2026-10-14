---
step: after-cross
---

Run the cross-prefix test again: A and B each exchange for credentials, and A uses its own ASIA credentials to write to B's prefix, list the whole bucket and delete B's object.

```bash {runsOn=workstation}
npm run exp -- identity-pool --label after --scenario cross-prefix --upload
```

::experiment{module=identity-pool id=cross-prefix label=after}

:::expected
`write-own` and `list-own` are allowed; `write-other`, `list-root` and `delete-other` all get 403 `AccessDenied` from S3, with `deniedBy: s3`;
`unexpected` = 0. Server-side evidence: A's own object exists, the object A tried to write to B's prefix does not, and B's object was not deleted.
:::

:::why
This time the denial happens in S3: IAM replaces `${cognito-identity.amazonaws.com:sub}` with A's identityId based on the requester's identity and compares it with the resource ARN.
Application code is not involved at all — which also means the app cannot see these requests (direct uploads to S3 pass through neither Nginx nor WAF); for auditing you need CloudTrail S3 data events (charged).
:::

::checks
