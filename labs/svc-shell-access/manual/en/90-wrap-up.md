---
section: wrap-up
---

## What you did

- Signed in to the instance and port-forwarded with no management port open inbound in the security group.
- No more distributing and rotating SSH private keys: sign-in uses IAM identities, and authorization can go down to instance tags and Session documents.
- Answered "who ran which command when" by lining up session history, session logs and CloudTrail.

## Exam points recap

- Session Manager, bastion hosts, EC2 Instance Connect and EC2 Instance Connect Endpoint: which need port 22, which need a public IP, and how each is audited.
- The three prerequisites of an SSM managed node; minimal exposure: zero inbound rules, stateful security groups.
- Reaching AWS services from private subnets: NAT gateways and interface endpoints; Session Manager needs `ssm` and `ssmmessages` (and `ec2messages` is recommended).
- Use IAM condition keys (`ssm:resourceTag/*`) to control who can sign in to which instances, and Session documents to control whether port forwarding is allowed.
- The trade-off between the AWS managed policy `AmazonSSMManagedInstanceCore` and a customer managed least-privilege policy.
