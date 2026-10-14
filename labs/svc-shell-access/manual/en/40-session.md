---
step: session
---

Sign in to the lab instance with Session Manager (the default document, no `--document-name`) and verify that the session opens as `cloudalbum-ops` with restricted sudo:

```bash {runsOn=workstation}
aws ssm start-session --target {{ target.instanceId }}
```

In the session that opens, run:

```bash {runsOn=lab}
id
sudo systemctl status cloudalbum-api --no-pager | head -3
printf '{"user":"%s","secretsRc":%d}\n' "$(id -un)" "$(sudo -n cat /etc/cloudalbum/secrets.env >/dev/null 2>&1; echo $?)"
exit
```

:::expected
`id` shows `cloudalbum-ops`; `systemctl status` is allowed; reading `secrets.env` is denied (`secretsRc` is non-zero). Paste the last line of JSON into the check.
:::

:::why
Both the default `ssm-user` and AL2023's `ec2-user` have passwordless sudo, so switching runAs to ec2-user does not reduce privileges. This module's hostSetup creates a dedicated user
`cloudalbum-ops` whose sudoers only allow complete commands listed one by one: `systemctl status cloudalbum-api|cloudalbum-worker --no-pager`,
`journalctl -u cloudalbum-api|cloudalbum-worker --no-pager`, `systemctl restart …`, `nginx -t` and `systemctl reload nginx`. Arguments never use `*`:
in sudoers, the `*` in `journalctl -u cloudalbum-*` matches any characters including spaces, which would allow `--vacuum-time=1s` (deleting system logs as root).
Note: Run Command (the delivery channel of `scripts/module`) always runs as root and is not affected by runAs.
:::

:::wait{typical=5 max=20}
CloudTrail's StartSession event lags by a few minutes to over ten minutes; you can do the port forwarding in the next step first.
:::

::checks
