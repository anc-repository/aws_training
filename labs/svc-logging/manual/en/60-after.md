---
step: after
---

Record after: the same fault and load as before, but this time both queries run side by side on the local and CloudWatch sides.

```bash {runsOn=workstation}
npm run exp -- logging --label after --scenario query-compare --upload
```

::experiment{module=logging id=query-compare label=after}

:::expected
`agreeLocal` and `agreeCloudwatch` are both true: the local scan, CloudWatch Insights and the number of 503s the client saw all match. The report gives the duration of both sides,
and bytes scanned for Insights. With one instance and little data, the local scan is often faster — CloudWatch wins on working across instances, staying searchable after an instance is gone and aggregating, not on the speed of this one query.
:::

:::tip
`npm run exp:report -- logging --experiment query-compare` produces the before-vs-after report.
:::

::checks
