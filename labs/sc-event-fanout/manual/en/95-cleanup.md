---
section: cleanup
---

- Automatic reclaim deletes the two module stacks, notification and email: the notification topic, inbox queue, subscription-level DLQ, SES configuration set, event topic, feedback queue and DLQ.
  Deleting a topic also deletes all of its subscriptions (including unconfirmed ones).
- The end dialog asks whether to keep the SES sender identity. If you keep it, it stays in the account, the next email deployment attaches to it read-only, and disabling does not delete it;
  delete it by hand under "Verified identities" in the SES console when you no longer need it.
- The sandbox status stays as it is, per Region; this card does not request production access. If you requested it separately, that is an account-level, per-Region status that the platform does not reclaim.
- Test users, in-app messages and `outbox_emails` records live in the lab instance's database and are deleted with it; `notification-users.json` on the workbench is deleted with the workbench.
- The verification, confirmation and notification emails in your mailbox stay there; nothing to do.
