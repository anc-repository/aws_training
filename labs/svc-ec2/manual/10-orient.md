---
step: orient
---

在 EC2 控制台认识你的实验机。这些配置由基础栈管理，**只看不改**。

:::method{kind=console default}
::console-link[打开实验机]{link=ec2.instance instanceId="{{ target.instanceId }}"}

1. “详细信息”：实例类型、可用区、公有 IPv4 地址（弹性 IP）、IAM 角色 `CloudAlbumAppRole`。
2. “安全”：实例元数据服务要求 IMDSv2（“必需”），跳数限制为 1；安全组的入站规则。
3. “存储”：两块 gp3 卷——根卷“终止时删除”为“是”；数据卷为“否”，已加密，带 `Backup=true` 标签。
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws ec2 describe-instances --instance-ids {{ target.instanceId }} --query "Reservations[0].Instances[0].{Type:InstanceType,AZ:Placement.AvailabilityZone,PublicIp:PublicIpAddress,Metadata:MetadataOptions,Profile:IamInstanceProfile.Arn}"
aws ec2 describe-volumes --filters Name=attachment.instance-id,Values={{ target.instanceId }} --query "Volumes[].{Id:VolumeId,Size:Size,Encrypted:Encrypted,Device:Attachments[0].Device,DeleteOnTermination:Attachments[0].DeleteOnTermination}"
```
:::

:::saa{domain=cost confusable="自动分配的公网 IPv4 vs 弹性 IP"}
AWS 对所有公网 IPv4 地址按小时计费，未关联的 EIP 同样计费；EIP 是区域资源，不能跨区域使用。
EBS 按预置的 GB-月计费，停止实例期间照常计费。
:::

::checks
