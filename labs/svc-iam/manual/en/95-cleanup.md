---
section: cleanup
---

- The reclaimer deletes the iam module stack and resets `CloudAlbumAppRole`: it detaches every policy the platform did not attach and deletes inline policies.
- Do not copy any access key into files on the lab instance or the workbench: the end-of-lab check `no-leaked-keys` scans the lab instance.
- This card creates no usage-billed or hourly-billed resources; while you keep the environment, only the lab instance and the workbench are billed.
