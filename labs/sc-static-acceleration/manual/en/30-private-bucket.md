---
step: private-bucket
---

Prove the bucket is still private: for the same object, a direct request to the bucket is refused, while a request through the distribution succeeds and hits the cache the second time.

First get a thumbnail's key in the bucket (the part after `/media/`) and call it `KEY`:

```bash {runsOn=workstation}
KEY=$(aws s3api list-objects-v2 --bucket {{ var.mediaBucket }} --prefix variants/ --max-items 1 --query "Contents[0].Key" --output text)
echo "$KEY"
```

Request the bucket directly (unsigned):

```bash {runsOn=workstation}
curl -s -o /dev/null -w "bucket: %{http_code}\n" "https://{{ var.mediaBucket }}.s3.{{ session.region }}.amazonaws.com/$KEY"
```

Request it twice through the distribution:

```bash {runsOn=workstation}
for i in 1 2; do curl -s -o /dev/null -D - "https://{{ var.cdnDomain }}/media/$KEY" | grep -iE "^(HTTP/|x-cache|age):"; sleep 1; done
```

:::expected
The direct request to the bucket returns `403`; through the distribution the first request gets `200` + `Miss from cloudfront` and the second `200` + `Hit from cloudfront` (occasionally both are Misses: the two curls can land on different cache hosts, so run it again).
:::

:::why
**OAC rather than a public bucket.** CloudFront signs and reads objects as the service principal `cloudfront.amazonaws.com`, and the bucket policy uses `AWS:SourceArn` to limit the allow to this distribution;
other distributions, other accounts and any direct request are refused. When objects use SSE-KMS, the key policy must also let this service principal decrypt — something OAI cannot do.
:::

::checks
