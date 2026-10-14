---
step: baseline
---

Record before: an upload load test with 10 concurrent clients, 5 MB per image, for 60 seconds, while reading the timeline a few times per second to see how uploads affect other APIs.

```bash {runsOn=workstation}
npm run exp -- storage --label before --scenario upload-burst --param fileMb=5 --duration 60s --upload
```

::experiment{module=storage id=upload-burst label=before}

:::tip
The module documentation's defaults are 20 MB and 120 seconds. The card uses 5 MB and 60 seconds: the L0 before writes originals to the 20 GiB data volume, and the defaults could push the disk close to its threshold and spoil later steps; the direction and order of magnitude of the results are unaffected.
:::

::checks
