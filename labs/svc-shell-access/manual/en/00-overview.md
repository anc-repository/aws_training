---
section: overview
---

## Background

Something is wrong with CloudAlbum and you need to sign in to EC2 to troubleshoot. The L0 way is SSH: the security group opens port 22 to operations IPs, and private keys have to be distributed, rotated and kept safe; afterwards you only know
"which public key signed in from which IP", not what was done after signing in. In platform mode, the lab instance's SSM Agent is already online for the "platform management channel", so this card does not compare
"SSM Agent or not" but **which path operators use to sign in, who can sign in, and whether it can be traced afterwards**.

:::why
Every Session Manager connection is opened **outbound** by the SSM Agent on the instance (443 to the `ssm` and `ssmmessages` endpoints), and operators connect with their own IAM identity through
Systems Manager. Security groups are stateful, so return traffic is allowed automatically and the instance needs no management port open inbound at all; every session is recorded in CloudTrail (who, when),
and the commands and output within a session are written to the session log group.
:::

## Comparison experiments

### Port probe (shell-access/probe-port, required)

- **Without (SSH baseline)**: probing port 22 on the lab instance's private address from the workbench shows open; the security group has a "22 ← workbench /32" rule.
- **With Session Manager**: the same probe times out (filtered), and the security group no longer has any inbound rule covering 22; 443 is unaffected.
- **Where you see it**: `port22.open` and `sgRules22` in the comparison report; shell-access's detail in capabilities changes from “未启用” (not enabled) to “无管理端口入站” (no management ports inbound).

### Audit chain (shell-access/session-audit, required)

- **With Session Manager**: session history (who, when) ↔ session logs (what was run) ↔ CloudTrail `StartSession` (IAM identity), lined up by session ID.
- **For comparison**: SSH only shows "public key fingerprint + source IP" in the journal and cannot answer "who ran which command".

## Platform mode notes

- The platform terminal uses its own Session document `ATL-SessionShell`, which this module does not touch; when counting sessions, platform terminal sessions are excluded and only the sessions you start from the workbench count.
- This module changes the account × Region singleton `SSM-SessionManagerRunShell` (session preferences): it backs up the original value to the environment state bucket before changing it and restores it at reclaim.
- In platform mode the delivery channel of `scripts/module` is SSM from the start, so the observation "delivery changes from ssh to ssm" does not apply to this card.
