---
step: baseline
---

Record the before: have the app report who it is and which credentials it uses.

```bash {runsOn=workstation}
npm run exp -- iam --label before --scenario whoami --upload
```

::experiment{module=iam id=whoami label=before}

:::expected
There is no caller ARN in the report: the app does not load the AWS SDK and holds no credentials at all.
:::

::checks
