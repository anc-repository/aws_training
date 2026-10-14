---
section: cleanup
---

- The configuration set, event topic, feedback queue and DLQ are deleted when the session is reclaimed.
- The end dialog asks whether to keep the SES sender identity. If you keep it, it stays in the account, is adopted read-only the next time email is deployed (`AdoptExistingIdentity=true`),
  and is not deleted when the module is disabled; when you no longer need it, delete it by hand under "Verified identities" in the SES console.
- The sandbox status stays the same per Region; this card does not request production access.
- If you tried the domain identity, delete the DKIM records you added by hand at your external DNS provider.
- The `outbox_emails` history lives in the lab instance's database and is deleted with the instance.
