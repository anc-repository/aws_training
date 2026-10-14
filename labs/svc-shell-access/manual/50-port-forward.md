---
step: port-forward
---

端口转发：把工作台的 13000 端口转发到实验机的 `127.0.0.1:3000`（api 进程），不需要开放 3000 端口，也不需要堡垒机。

```bash {runsOn=workstation}
aws ssm start-session --target {{ target.instanceId }} \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3000"],"localPortNumber":["13000"]}'
```

保持它运行，在另一个工作台终端执行，并把输出粘贴到检查里：

```bash {runsOn=workstation}
curl -s -o /dev/null -w '{"status":%{http_code}}' http://localhost:13000/api/health/ready
```

:::expected
输出 `{"status":200}`。结束后在端口转发的终端按 Ctrl+C。
:::

:::tip
数据库在私有子网（database=rds）时，用 `AWS-StartPortForwardingSessionToRemoteHost` 经这台实例转发到 RDS 端点，取代“临时把 5432 开给运维 IP”。
端口转发会话不记录传输的内容。
:::

::checks
