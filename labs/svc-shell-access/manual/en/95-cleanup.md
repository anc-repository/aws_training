---
section: cleanup
---

- Automatic reclaim first runs the equivalent of `scripts/module disable shell-access`: it **restores** `SSM-SessionManagerRunShell` from the backup, deletes `cloudalbum-ops`
  and the sudoers snippet, detaches the policy and deletes the stack; the session log group is `DeletionPolicy: Retain`, so the reclaimer deletes it.
- `SSM-SessionManagerRunShell` is an account × Region singleton that affects every session in the Region that uses the default document: do not change it by hand on the Session Manager "Preferences" page in the console.
- If you temporarily added a 22 rule to the security group for troubleshooting, delete it before the lab ends (the final review checks this).
- End port-forwarding sessions with Ctrl+C on the workbench; shell sessions disconnect automatically after 20 idle minutes (the session preference `idleSessionTimeout`).
- When used standalone (outside the platform), disabling must explicitly reopen 22: `scripts/module disable shell-access --reopen-ssh` (add `--param SshIngressCidr=<ip>/32` if the operations IP changed).
