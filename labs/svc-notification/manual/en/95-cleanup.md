---
section: cleanup
---

- The topic, inbox queue and subscription-level DLQ are deleted when the session is reclaimed; deleting the topic also deletes all of its subscriptions (including unconfirmed ones), and pending subscriptions expire on their own anyway.
- Confirmation and notification emails stay in your mailbox; nothing to do.
- The test users, in-app messages and `notification_prefs` all live in the lab instance's database and are deleted with it; `notification-users.json` on the workbench is deleted with the workbench.
- To disable manually in standalone mode: `scripts/module disable notification --no-migrate` (before the migration framework is in place; deleting the topic deletes the remaining subscriptions).
