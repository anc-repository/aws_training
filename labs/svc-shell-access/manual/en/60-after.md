---
step: after
---

Record after: probe ports 22 and 443 on the private address from the workbench again.

```bash {runsOn=workstation}
npm run exp -- shell-access --label after --scenario probe-port --param target=private-ip --upload
```

::experiment{module=shell-access id=probe-port label=after}

:::expected
`port22.result` becomes `filtered` (all timeouts) and `sgRules22` is 0; 443 is unaffected. `ssh lab` now times out — exactly as expected.
:::

:::tip
`npm run exp:report -- shell-access --experiment probe-port` produces the before-vs-after report.
:::

::checks
