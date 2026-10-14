---
step: orient
---

First, get a clear view of the starting point: port 22 is only open to the workbench's private address; the lab instance's SSM Agent is already online (the platform management channel), but the app considers shell-access "not enabled".

```bash {runsOn=workstation}
aws ec2 describe-security-group-rules --filters Name=group-id,Values={{ target.sgId }} \
  --query "SecurityGroupRules[?IsEgress==\`false\`].[IpProtocol,FromPort,ToPort,CidrIpv4]" --output table
aws ssm describe-instance-information --filters Key=InstanceIds,Values={{ target.instanceId }} \
  --query "InstanceInformationList[0].[PingStatus,AgentVersion]" --output text
ssh lab 'sudo sshd -T | grep -E "^(passwordauthentication|permitrootlogin|maxauthtries)"'
```

:::expected
The security group has one rule `tcp 22 22 <workbench private IP>/32`; `PingStatus` is already `Online`; sshd's effective configuration is `passwordauthentication no`,
`permitrootlogin no`, `maxauthtries 3`. shell-access's driver in capabilities is `ssh`, with status `off`.
:::

:::why
**The platform channel ≠ the operator channel.** The lab instance carries an instance role with only `AmazonSSMManagedInstanceCore`, so it is an SSM managed node from the start (all three prerequisites —
the agent, the instance role and an outbound path to `ssm` / `ssmmessages` — are met). What this card changes is how operators sign in: close 22 and switch to IAM identity sign-in.
:::

::checks
