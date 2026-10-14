---
section: overview
---

## Background

At L0 the app calls no AWS API at all. From this card on, the app gets **temporary credentials** from IMDSv2 through the instance profile: valid for hours, rotated automatically by EC2 and never written to disk.
The later storage, queue, cdn and other modules all build on this step. The counter-example is writing a long-term access key (`AKIA…`) to disk: it never expires and spreads with every snapshot, backup and log.

:::why
**An instance having a role does not mean the app uses it.** In platform mode the lab instance carries `CloudAlbumAppRole` from the start (with only `AmazonSSMManagedInstanceCore`; it is the platform's management channel).
"Without" in this card means the app's `IAM_CREDENTIALS=none`: the app never reads that role. When you enable iam, `scripts/module` attaches the iam module's own read-only policy to the role
and switches the app to the instance role; from then on, every module you enable attaches one customer managed policy of its own — least privilege that grows and shrinks with the modules.
:::

## Comparison experiments

### Identity check (iam/whoami, required)

- **Without (none)**: the app cannot call AWS APIs, and whoami reports "no credentials".
- **With the instance role (role)**: the caller is `assumed-role/CloudAlbumAppRole/<instance ID>`, the key starts with `ASIA`, and it has an expiry time.
- **Where you will see it**: the whoami report; the iam card on `/lab`; `userIdentity` in CloudTrail events.
- **Counter-example (read only)**: long-term keys start with `AKIA` and have no expiry; once leaked, the only fix is to deactivate the key, and the business stops with it.

## Platform mode notes

In platform mode, `enable iam` runs with `AppRoleMode=existing`: `CloudAlbumAppRole` and the instance profile belong to the platform, and the module only creates and attaches its own read-only policy.
This card creates no usage-billed or hourly-billed resources.
