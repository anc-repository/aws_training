---
step: port-forward
---

Port forwarding: forward port 13000 on the workbench to `127.0.0.1:3000` on the lab instance (the api process) — no need to open port 3000, and no bastion host.

```bash {runsOn=workstation}
aws ssm start-session --target {{ target.instanceId }} \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3000"],"localPortNumber":["13000"]}'
```

Keep it running, run this in another workbench terminal, and paste the output into the check:

```bash {runsOn=workstation}
curl -s -o /dev/null -w '{"status":%{http_code}}' http://localhost:13000/api/health/ready
```

:::expected
The output is `{"status":200}`. When you are done, press Ctrl+C in the port-forwarding terminal.
:::

:::tip
When the database is in a private subnet (database=rds), use `AWS-StartPortForwardingSessionToRemoteHost` to forward through this instance to the RDS endpoint, instead of "temporarily opening 5432 to the operations IP".
Port-forwarding sessions do not record the transferred content.
:::

::checks
