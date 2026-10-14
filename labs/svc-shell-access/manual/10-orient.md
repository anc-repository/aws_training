---
step: orient
---

先看清起点：22 端口只对工作台私网地址开放；实验机的 SSM Agent 已经在线（平台管理通道），但应用把 shell-access 视为“未启用”。

```bash {runsOn=workstation}
aws ec2 describe-security-group-rules --filters Name=group-id,Values={{ target.sgId }} \
  --query "SecurityGroupRules[?IsEgress==\`false\`].[IpProtocol,FromPort,ToPort,CidrIpv4]" --output table
aws ssm describe-instance-information --filters Key=InstanceIds,Values={{ target.instanceId }} \
  --query "InstanceInformationList[0].[PingStatus,AgentVersion]" --output text
ssh lab 'sudo sshd -T | grep -E "^(passwordauthentication|permitrootlogin|maxauthtries)"'
```

:::expected
安全组里有一条 `tcp 22 22 <工作台私网 IP>/32`；`PingStatus` 已经是 `Online`；sshd 的生效配置是 `passwordauthentication no`、
`permitrootlogin no`、`maxauthtries 3`。capabilities 中 shell-access 的驱动是 `ssh`、状态 `off`。
:::

:::why
**平台通道 ≠ 运维通道。** 实验机挂着只含 `AmazonSSMManagedInstanceCore` 的实例角色，所以它从一开始就是 SSM 托管节点（三个前提：
Agent、实例角色、到 `ssm` / `ssmmessages` 的出站通路都满足）。本卡要改的是“运维者怎么登录”：关掉 22、换成 IAM 身份登录。
:::

::checks
