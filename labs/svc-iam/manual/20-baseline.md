---
step: baseline
---

记录 before：让应用报告“我是谁、用什么凭证”。

```bash {runsOn=workstation}
npm run exp -- iam --label before --scenario whoami --upload
```

::experiment{module=iam id=whoami label=before}

:::expected
报告中没有调用者 ARN：应用不加载 AWS SDK，也不持有任何凭证。
:::

::checks
