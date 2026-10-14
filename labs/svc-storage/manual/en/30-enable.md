---
step: enable
---

Enable storage: the module deploys the original image bucket and the display bucket, migrates existing photos to S3 during a read-only window, then switches the driver, restarts and runs the deep probe.

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable storage --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable storage
```
:::

:::wait{typical=3 max=15}
During the migration the app is in a read-only window (you can browse but not upload). When it finishes, upload one photo in the App preview so the platform sees a real presigned upload.
:::

:::expected
storage is Healthy; the media URL host is `cloudalbum-{{ session.env }}-storage-(raw or media)-<account>-<Region>.s3.{{ session.region }}.amazonaws.com` with signature parameters;
the upload request's path header shows `storage=s3:presign`.
:::

::checks
