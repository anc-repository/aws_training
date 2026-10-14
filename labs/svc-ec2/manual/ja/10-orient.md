---
step: orient
---

EC2 コンソールでラボ用インスタンスを確認します。これらの設定は基本スタックが管理しているので、**見るだけで変更しないでください**。

:::method{kind=console default}
::console-link[ラボ用インスタンスを開く]{link=ec2.instance instanceId="{{ target.instanceId }}"}

1. 「詳細」：インスタンスタイプ、アベイラビリティーゾーン、パブリック IPv4 アドレス（Elastic IP）、IAM ロール `CloudAlbumAppRole`。
2. 「セキュリティ」：インスタンスメタデータサービスで IMDSv2 が「必須」、ホップ数の制限が 1 になっていること。セキュリティグループのインバウンドルール。
3. 「ストレージ」：gp3 のボリュームが 2 つあります。ルートボリュームは「終了時に削除」が「はい」、データボリュームは「いいえ」で、暗号化されており、`Backup=true` タグが付いています。
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws ec2 describe-instances --instance-ids {{ target.instanceId }} --query "Reservations[0].Instances[0].{Type:InstanceType,AZ:Placement.AvailabilityZone,PublicIp:PublicIpAddress,Metadata:MetadataOptions,Profile:IamInstanceProfile.Arn}"
aws ec2 describe-volumes --filters Name=attachment.instance-id,Values={{ target.instanceId }} --query "Volumes[].{Id:VolumeId,Size:Size,Encrypted:Encrypted,Device:Attachments[0].Device,DeleteOnTermination:Attachments[0].DeleteOnTermination}"
```
:::

:::saa{domain=cost confusable="自动分配的公网 IPv4 vs 弹性 IP"}
AWS はすべてのパブリック IPv4 アドレスを時間課金し、関連付けられていない EIP も課金されます。EIP はリージョン単位のリソースで、リージョンをまたいで使うことはできません。
EBS はプロビジョニングした GB-月で課金され、インスタンスの停止中も通常どおり課金されます。
:::

::checks
