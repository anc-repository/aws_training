---
section: cleanup
---

- Platform reclaim empties **all versions** and delete markers from both buckets and then deletes them (the buckets' `DeletionPolicy: Retain` only affects stack deletion, not reclaim). You do not need to run `disable storage` within the card.
- Do not upload private photos: versioning keeps old versions until reclaim deletes them.
- If you ran `ebs-growth` and the script was interrupted, release the placeholder file first (see that step).
- While you keep the environment, S3 storage continues to be billed by usage (tiny at learning scale).
