---
step: baseline
---

Record before: probe ports 22 and 443 on the lab instance's **private address** from the workbench (5 times each, 3-second timeout), and read the security group's port 22 rules as server-side evidence.

```bash {runsOn=workstation}
npm run exp -- shell-access --label before --scenario probe-port --param target=private-ip --upload
```

::experiment{module=shell-access id=probe-port label=before}

Then sign in once with SSH and see what audit information SSH leaves behind:

```bash {runsOn=workstation}
ssh lab 'id; sudo journalctl -u sshd -n 5 --no-pager -o cat'
```

:::expected
In the report `port22.result` is `open` and `sgRules22` is 1; the journal only has `Accepted publickey for ec2-user from <workbench IP> … SHA256:…`:
you know "which key signed in from which IP", but not what was done afterwards.
:::

:::tip
In platform mode 22 is only open to the workbench's private address, so probing the public address already times out at before; that is why this uses `--param target=private-ip`
(the runner looks up the lab instance's private address with `aws ec2 describe-instances`).
:::

::checks
