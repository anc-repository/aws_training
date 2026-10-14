---
step: orient
---

Open the album in the App preview and look at the thumbnail requests in the Network panel of the browser's developer tools: the host is `cloudalbum-{{ session.env }}-storage-media-…s3.{{ session.region }}.amazonaws.com`,
the URL carries signature parameters such as `X-Amz-Signature`, and it changes every time you reload.

Then record before: the runner keeps loading the album JSON, 30 thumbnails and 1 display image for 5 minutes.

```bash {runsOn=workstation}
npm run exp -- cdn --label before --scenario media-load --upload
```

::experiment{module=cdn id=media-load label=before}

:::expected
Every thumbnail is a request to S3; the origin request count in the report is proportional to traffic.
:::

:::tip
Optional: `npm run exp -- cdn --label before --scenario ttfb --upload` records time to first byte, for reference only (the workbench and the lab instance are both in Tokyo).
:::

::checks
