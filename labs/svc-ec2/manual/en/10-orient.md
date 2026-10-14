---
step: orient
---

Get to know your lab instance in the EC2 console. These settings are managed by the base stack, so **look but do not change**.

:::method{kind=console default}
::console-link[Open the lab instance]{link=ec2.instance instanceId="{{ target.instanceId }}"}

1. "Details": instance type, Availability Zone, public IPv4 address (the Elastic IP), IAM role `CloudAlbumAppRole`.
2. "Security": the instance metadata service requires IMDSv2 ("Required") with a hop limit of 1; the security group's inbound rules.
3. "Storage": two gp3 volumes — the root volume has "Delete on termination" set to Yes; the data volume has No, is encrypted and is tagged `Backup=true`.
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws ec2 describe-instances --instance-ids {{ target.instanceId }} --query "Reservations[0].Instances[0].{Type:InstanceType,AZ:Placement.AvailabilityZone,PublicIp:PublicIpAddress,Metadata:MetadataOptions,Profile:IamInstanceProfile.Arn}"
aws ec2 describe-volumes --filters Name=attachment.instance-id,Values={{ target.instanceId }} --query "Volumes[].{Id:VolumeId,Size:Size,Encrypted:Encrypted,Device:Attachments[0].Device,DeleteOnTermination:Attachments[0].DeleteOnTermination}"
```
:::

:::saa{domain=cost confusable="自动分配的公网 IPv4 vs 弹性 IP"}
AWS bills every public IPv4 address by the hour, unassociated EIPs included; an EIP is a Regional resource and cannot be used in another Region.
EBS is billed per provisioned GB-month and keeps being billed while the instance is stopped.
:::

::checks
