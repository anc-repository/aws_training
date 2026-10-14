---
step: resume
---

Resumable upload: upload a 24 MB file (3 parts), interrupt it before the second part, then resume.

```bash {runsOn=workstation}
npm run exp -- identity-pool --label after --scenario resume --upload
```

To really cut the network once, add `--param pauseSec=30`; when the script prints "模拟断网" (simulating a network drop), disconnect the workbench's network and reconnect it a few seconds later.

::experiment{module=identity-pool id=resume label=after}

:::expected
`totalParts=3`, `partsBeforeInterruption=1`, `partsResent=2`, `onlyMissingResent=true`; the server-side evidence `partsReportedBeforeResume=1`
comes from S3's `ListParts`, and after complete the photo is `PROCESSING` / `READY` on the server.
:::

:::tip
Uploading a large file can take longer than the credentials last: the browser asks `/api/uploads/credentials` again when less than 5 minutes remain, and when a part gets `ExpiredToken`
it refreshes and retries once. Multipart uploads that never complete are aborted automatically after 1 day by the staging bucket's lifecycle rule.
:::

::checks
