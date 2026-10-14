---
step: failures
---

Failure paths: upload corrupt JPEGs (a valid file header + random bytes). That is a permanent error — no number of retries will make it succeed — so the function writes back FAILED directly, without throwing and without retrying.

```bash {runsOn=workstation}
npm run exp -- image-processing --label after --scenario failures --param count=3 --upload
```

::experiment{module=image-processing id=failures label=after}

:::expected
All 3 photos quickly become FAILED (`scenario.notFailed` is 0); the failure queue stays empty.
:::

:::why
**Permanent and transient errors must be handled separately**: for a transient error (a downstream timeout, throttling) the function throws, Lambda retries asynchronously twice (about 1 and 2 minutes apart),
and once retries are used up the event goes to the on-failure destination for the app to reconcile; retrying a permanent error only wastes invocation charges, so the function should decide for itself and write the result back directly.
:::

:::tip
Further reading: the module's function supports an environment variable `FAULT_RATE` (0–1) that throws transient errors at that rate. A manual demo means changing the function's environment variables with `aws lambda update-function-configuration`
(you must include all existing variables); this card does not ask you to do it. If you did run the demo, run
`scripts/module enable image-processing --param ResultChannel=queue` again before you finish to restore the configuration; this step's check keeps confirming that `FAULT_RATE` is absent.
:::

::checks
