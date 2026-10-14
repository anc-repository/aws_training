---
step: sidebyside
---

(Optional) Upload through the local and s3 paths alternately, at the same time and on the same instance. It only writes the `lab/` prefix and cleans up automatically afterwards:

```bash {runsOn=workstation}
npm run exp -- storage --label after --scenario upload-sidebyside --param fileMb=5 --upload
```

::experiment{module=storage id=upload-sidebyside label=after}

:::expected
In the same period, the differences in "upload complete" time and lab instance received bytes between the two paths point the same way as before/after.
:::

::checks
