---
section: cleanup
---

- The User Pool has `Retain` and deletion protection: when the stack is deleted it is recorded in the ledger as a retained resource, and the reclaimer turns deletion protection off and then deletes it. You do not need to do anything by hand.
- Emails Cognito has already sent to your mailbox cannot be recalled; do not sign up test accounts with other people's email addresses.
- While you keep the environment, the User Pool is billed by monthly active users (learning-scale usage usually stays within the free allowance).
