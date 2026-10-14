---
step: observe-direct-upload
---

Upload three more photos in the App preview and watch in the developer tools: an upload takes two steps — first ask this site for a presigned URL, then PUT the file to S3.

In the workbench terminal, see where the objects ended up:

```bash {runsOn=workstation}
aws s3api list-objects-v2 --bucket {{ var.rawBucket }} --prefix raw/ --max-items 5 --query "Contents[].[Key,Size]" --output table
```

:::expected
The PUT request's host is `{{ var.rawBucket }}.s3.{{ session.region }}.amazonaws.com` and the URL carries `X-Amz-Signature`;
the objects you just uploaded appear under the `raw/` prefix; the lab instance's network card shows almost no inbound traffic growing with the uploads.
:::

::checks
