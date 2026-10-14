---
step: whoami
---

Record the after: the same identity check, this time with the app using the instance role.

```bash {runsOn=workstation}
npm run exp -- iam --label after --scenario whoami --upload
```

::experiment{module=iam id=whoami label=after}

:::expected
The caller is `arn:aws:sts::<account>:assumed-role/CloudAlbumAppRole/<instance ID>`; the key prefix is `ASIA`; it expires in a few hours; the number of long-term keys on disk is 0.
:::

:::why
**Why are temporary credentials safer?** They expire, EC2 rotates them before they do, and the SDK refreshes them automatically; they only exist in IMDS and in process memory, never in snapshots or backups.
If you suspect a leak, you can "Revoke active sessions" on the role (denying old sessions by `aws:TokenIssueTime`) without deleting the role.
:::

::checks
