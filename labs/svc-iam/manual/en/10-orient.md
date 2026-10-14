---
step: orient
---

In the **lab instance terminal**, use IMDSv2 to read the instance role's name (only the name — do not print the credentials):

```bash {runsOn=lab}
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/; echo
```

Then look at the app's own credential setting:

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq ".modules.iam | {driver, status, detail}"
```

:::expected
IMDS returns the role name `CloudAlbumAppRole`; the app's iam driver is `none` with status `off`. The instance has a role, but the app is not using it.
:::

:::danger
Do not request `iam/security-credentials/CloudAlbumAppRole`: that would print the temporary credentials to the terminal and your shell history.
:::

::checks
