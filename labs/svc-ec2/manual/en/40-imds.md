---
step: imds
---

Simulate an SSRF that can only make the server send GET requests on its behalf: read the metadata directly without a session token.

```bash {runsOn=lab}
curl -s -o /dev/null -w "without token: %{http_code}\n" http://169.254.169.254/latest/meta-data/instance-id
```

The proper flow first gets a session token with PUT, then reads with the token:

```bash {runsOn=lab}
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id; echo
```

:::expected
The request without a token returns `401`; the request with a token returns the instance ID.
:::

:::why
IMDSv2 has two gates: getting a token takes a `PUT` with a specific request header, while a typical SSRF can only make the server send GET; and the hop limit on the token response (1 here) keeps the token from leaving the instance.
The instance metadata service is a link-local address local to the instance, which neither security groups nor NACLs control.
:::

::checks
