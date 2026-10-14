---
step: orient
---

まず出発点を確認します。22 番ポートはワークベンチのプライベートアドレスにだけ開いています。ラボ用インスタンスの SSM Agent はすでにオンラインですが（プラットフォームの管理チャネル）、アプリは shell-access を「未有効」とみなしています。

```bash {runsOn=workstation}
aws ec2 describe-security-group-rules --filters Name=group-id,Values={{ target.sgId }} \
  --query "SecurityGroupRules[?IsEgress==\`false\`].[IpProtocol,FromPort,ToPort,CidrIpv4]" --output table
aws ssm describe-instance-information --filters Key=InstanceIds,Values={{ target.instanceId }} \
  --query "InstanceInformationList[0].[PingStatus,AgentVersion]" --output text
ssh lab 'sudo sshd -T | grep -E "^(passwordauthentication|permitrootlogin|maxauthtries)"'
```

:::expected
セキュリティグループに `tcp 22 22 <ワークベンチのプライベート IP>/32` のルールが 1 つあります。`PingStatus` はすでに `Online` です。sshd の有効な設定は `passwordauthentication no`、
`permitrootlogin no`、`maxauthtries 3` です。capabilities の shell-access のドライバーは `ssh`、状態は `off` です。
:::

:::why
**プラットフォームのチャネル ≠ 運用のチャネル。** ラボ用インスタンスには `AmazonSSMManagedInstanceCore` だけを含むインスタンスロールが付いているため、最初から SSM マネージドノードです（3 つの前提、
エージェント、インスタンスロール、`ssm` / `ssmmessages` への送信経路がすべてそろっています）。このカードで変えるのは「運用担当者がどうログインするか」です。22 を閉じて、IAM ID でのログインに切り替えます。
:::

::checks
