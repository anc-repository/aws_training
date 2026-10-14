---
section: cleanup
---

- The platform's reclaim deletes the function, log group, event rule, failure queue and result queue this session created; the originals and thumbnails are in storage's buckets, which the reclaimer empties and deletes.
- Make sure the reserved concurrency from step 6 has been removed and that the optional demo's `FAULT_RATE` has been reverted (the checks will remind you); if you compared against provisioned concurrency, delete that configuration.
- While you keep the environment, Lambda and SQS are only billed per invocation and request; long polling of the result queue keeps generating a small number of requests.
