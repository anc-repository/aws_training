---
section: cleanup
---

- The identity pool, the Uploader role and the staging bucket are deleted when the session is reclaimed; the staging bucket is emptied and unfinished multipart uploads are aborted before it is deleted (the reclaimer takes care of it).
- The original-image bucket (storage) and the User Pool (auth) are start-state resources that the platform also reclaims; the reclaimer turns off the User Pool's deletion protection first.
- Do not copy the temporary credentials that the browser or the experiment scripts received to use elsewhere: they expire within about an hour and stop working as soon as the role is deleted, but until then they can write to your prefix.
- To disable it by hand in standalone mode: `scripts/module disable identity-pool` (it first empties the staging bucket and aborts unfinished multipart uploads, then detaches the PolicyArn and deletes the stack);
  `users.identity_id` is kept, but it is tied to the deleted identity pool (stored as `<pool ID>|<identityId>`): enabling the module again creates a new identity pool,
  each user gets a new identityId the first time they exchange for credentials, and the old values are ignored automatically — no manual cleanup is needed.
