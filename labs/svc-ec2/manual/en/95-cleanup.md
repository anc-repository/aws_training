---
section: cleanup
---

- The platform's reclaim deletes the base stack. The data volume has `DeletionPolicy: Retain`, so after the stack is deleted it is recorded in the ledger as a retained resource and the reclaimer deletes it; you do not need to delete the volume by hand.
- If you stopped the instance in step 5, **always start it again**; if you changed instance metadata options (such as the hop limit) outside step 4, change them back before you end the lab.
- While you keep the environment, the instance, EBS and public IPv4 are billed as usual.
