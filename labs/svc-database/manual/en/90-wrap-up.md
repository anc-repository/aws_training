---
section: wrap-up
---

## What you did

- Replaced SQLite with Multi-AZ RDS for PostgreSQL and got managed backups, point-in-time recovery and automatic failover with the same repository code.
- Triggered a failover yourself and saw the primary change AZ and the app reconnect automatically after a short period of failed writes.
- Confirmed that the database can only be reached from the lab instance: chained security groups + not publicly accessible + enforced TLS.

## Exam points recap

- Multi-AZ instance deployment vs Multi-AZ DB cluster deployment vs read replicas.
- Automated backups (up to 35 days), point-in-time recovery (restored as a new instance), manual snapshots, cross-Region snapshot copies.
- Encryption can only be turned on at creation; an unencrypted instance is converted via "snapshot → encrypted copy → restore".
- RDS-managed master passwords and rotation, IAM database authentication, where RDS Proxy fits; a stopped instance is started automatically once it exceeds the maximum stop time.
