---
step: wire
---

Enable shell-access. The script runs in a "don't lock yourself out" order: deploy the policy and the session log group → attach the policy **first**, confirm the agent is `Online` and smoke-test with Run Command
→ back up and write the session preferences (runAs `cloudalbum-ops`, logs to `/cloudalbum/{{ session.env }}/ssm-sessions`) → finally clear the base stack parameter
`SshIngressCidr`, which deletes the port 22 rule; delivery creates `cloudalbum-ops` and its restricted sudoers on the lab instance.

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable shell-access --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable shell-access
```
:::

:::wait{typical=3 max=10}
If any check fails (agent not online, smoke test fails), the script aborts with exit code 5 and port 22 stays as it is.
:::

::console-link[Open the lab instance's security group in the EC2 console]{link=ec2.securityGroup sgId="{{ target.sgId }}"}

:::expected
shell-access's driver is `ssm` and it is healthy, with a detail like “Agent Online（版本 …） · 无管理端口入站 · 会话日志 → /cloudalbum/{{ session.env }}/ssm-sessions” (agent online · no management ports inbound · session logs → …);
the security group no longer has a port 22 rule.
:::

:::saa{domain=secure confusable="AmazonSSMManagedInstanceCore vs 最小权限"}
`AmazonSSMManagedInstanceCore` is convenient, but it also grants read access to **every** Parameter Store parameter. This module's policy only contains what sessions and Run Command
need, writing session logs, the sensor's read-only calls, and read access to the one-time hand-off parameters under `/cloudalbum/{{ session.env }}/handoff/*` (when `scripts/module`
delivers secrets over SSM, it hands them off as SecureStrings and deletes them after use); `--param ManagedCore=true` keeps the managed policy for comparison.
:::

:::tip
In standalone mode (your own account, without the platform), enabling this module switches `scripts/module` delivery to SSM: secrets are only **written** to `secrets.env` through SecureString hand-off parameters
and never read back (Run Command output stays in the command history). Enabling a module afterwards that must reuse existing secrets (cdn's `ORIGIN_VERIFY`,
database's `DB_PASSWORD`, image-processing's `CALLBACK_HMAC_KEY`) then aborts with `SECRETS_READBACK_OVER_SSM` and tells you what to do:
enable those modules before shell-access; or enable it with `--param KeepSsh=true` to keep port 22 and add `--delivery ssh` to those commands;
or run `scripts/module disable shell-access --reopen-ssh` first.
:::

::checks
