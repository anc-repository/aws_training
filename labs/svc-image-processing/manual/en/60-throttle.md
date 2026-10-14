---
step: throttle
---

Emergency brake: set the function's reserved concurrency to 0 (the same as pausing the function), upload 2–3 photos in the preview, watch for 2 minutes, then remove the reserved concurrency.

```bash {runsOn=workstation}
aws lambda put-function-concurrency --function-name "{{ var.functionName }}" --reserved-concurrent-executions 0
aws lambda get-function-concurrency --function-name "{{ var.functionName }}"
```

Upload 2–3 photos in the app preview, then open the function's "Monitor" page and look at `Throttles` and `AsyncEventsDropped` (the metrics lag by about 1–2 minutes).

```bash {runsOn=workstation}
aws lambda delete-function-concurrency --function-name "{{ var.functionName }}"
aws lambda get-function-concurrency --function-name "{{ var.functionName }}"
```

:::warning
Always run the final `delete-function-concurrency`. If reserved concurrency stays at 0, no thumbnail will be generated for any photo after this; both this step and the end-of-lab check confirm that it was removed.
:::

:::expected
While paused, `Throttles` or `AsyncEventsDropped` show non-zero values. According to the AWS docs, with reserved concurrency at 0 asynchronous events do not wait in a queue until it is lifted; they are dropped and sent to the on-failure destination;
the app's reconciliation job then handles those photos (redelivering or marking them FAILED — check what you actually observe). Once the reserved concurrency is removed, newly uploaded photos work normally again.
:::

:::saa{domain=performance confusable="预留并发 vs 预置并发"}
Reserved concurrency carves a slice out of the account's concurrency quota and is both a guaranteed minimum and a ceiling; 0 is the brake. Provisioned concurrency pre-initializes execution environments, removes cold starts and is billed by time.
New accounts can have a low concurrency quota, and reserving a lot squeezes other functions.
:::

::checks
