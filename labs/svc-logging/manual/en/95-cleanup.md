---
section: cleanup
---

- The logging stack is deleted when the session is reclaimed; the two log groups are `DeletionPolicy: Retain`, so the reclaimer deletes them as retained resources.
- The CloudWatch agent snippet installed in the optional step is removed by the hostSetup revert, and the lab instance is deleted with the session.
- If you created a subscription filter, Firehose stream or export task for archiving yourself, those are not logging stack resources: delete them before the lab ends if you no longer need them.
