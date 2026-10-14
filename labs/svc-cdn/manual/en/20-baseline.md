---
step: baseline
---

Before you enable CloudFront, record the origin load while EC2 serves everything directly. This is the before of the comparison.

The runner loads the album JSON, 30 thumbnails and 1 display image for 5 minutes and uploads the results to the platform:

```bash {runsOn=workstation}
npm run exp -- cdn --label before --scenario media-load --upload
```

::experiment{module=cdn id=media-load label=before}

:::expected
When the run ends it prints the `runId` and `== cdn/media-load · before`; within a few dozen seconds the platform finishes cross-checking and the check turns to Passed.
:::

:::tip
While it runs, you can open the lab instance terminal and run `sudo tail -f /var/lib/cloudalbum/logs/nginx-access.json | jq -c '{uri, status}'` to watch every request hit Nginx.
:::

::checks
