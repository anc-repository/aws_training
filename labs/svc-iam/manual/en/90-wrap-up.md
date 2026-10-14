---
section: wrap-up
---

## What you did

- Gave the app its first AWS identity: temporary credentials from the instance role, never written to disk and rotated automatically.
- Confirmed that IMDSv2 stops an SSRF that can only send GET, and recognized `AssumedRole` and `ASIA` in CloudTrail.

## Exam points recap

- IAM users, groups, roles and policies; AWS managed, customer managed and inline policies; instance profiles and `iam:PassRole`.
- STS temporary credentials and automatic rotation; `aws:TokenIssueTime` and revoking sessions (the instance only recovers once it gets a new session).
- IMDSv2 and SSRF, the hop limit; the order of the SDK's default credential chain.
- Policy evaluation logic: explicit Deny wins, the default is deny, `GetCallerIdentity` is the exception; how permissions boundaries, SCPs and identity-based policies relate.
