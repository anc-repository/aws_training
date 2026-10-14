---
section: wrap-up
---

## What you did

- Learned what L0 is made of: the instance, the root volume and the separate data volume, the Elastic IP, the security group, IMDSv2, and an instance role used only for the platform's management channel.
- Confirmed that the data and secrets are on the data volume, so the instance is replaceable — and proved for yourself that it is still a single point of failure.

## Exam points recap

- EBS volumes and instances have independent lifecycles; the default of `DeleteOnTermination`; EBS is tied to an AZ, and snapshots copy across AZs and Regions.
- How durable instance store is compared with EBS; Elastic IP and public IPv4 billing.
- IMDSv2, the hop limit and SSRF; User Data with `CreationPolicy` + `cfn-signal`; resolving the latest AMI through SSM public parameters.
- T-family CPU credits (standard / unlimited); security groups are stateful and only have allow rules; high availability is not the same as having backups.
