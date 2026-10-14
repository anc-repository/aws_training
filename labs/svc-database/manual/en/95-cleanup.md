---
section: cleanup
---

- **Billed hourly**: you can end the lab early once the required steps are done; extending it or keeping the environment keeps billing both Multi-AZ instances.
- The stack's `DeletionPolicy: Snapshot` leaves a final snapshot; the platform's reclaim deletes the instance (skipping the final snapshot and deleting automated backups) and deletes any final snapshot already taken, so there is no need to run `disable database` inside the card.
- The optional point-in-time restore or read replica: delete it as soon as you have verified it; if you were interrupted, run `aws rds delete-db-instance --skip-final-snapshot --delete-automated-backups` by hand.
- **Do not turn on deletion protection**: it makes the reclaim fail, and the session goes to CLEANUP_FAILED.
