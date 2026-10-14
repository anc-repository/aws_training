---
step: orient
---

First, get a clear view of the starting point: photos are written to the lab instance's data volume, and upload requests go to the lab instance itself.

1. Upload one photo in the App preview on the right and find the upload request in the Network panel of the developer tools: the PUT goes to this site's `/api/storage/upload`.
2. In the lab terminal, look at the data volume usage:

```bash {runsOn=lab}
df -h /var/lib/cloudalbum
sudo du -sh /var/lib/cloudalbum/uploads
```

:::expected
The upload request's `X-CloudAlbum-Path` contains `storage=local:write`; the original you just uploaded appears under `/var/lib/cloudalbum/uploads`.
:::

::checks
