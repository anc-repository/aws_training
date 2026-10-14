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
curl -s -o /dev/null -w "with token: %{http_code}\n" -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id
```

:::expected
The request without a token returns `401`; the request with a token returns `200`.
:::

:::why
IMDSv2 has two gates: getting a token takes a `PUT` with the `X-aws-ec2-metadata-token-ttl-seconds` request header, which an SSRF that can only send GET cannot do;
and the IP hop limit on the token response (1 by default, often 2 for containers) keeps the token from leaving the instance.
:::

::checks
