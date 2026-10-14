---
step: agent
---

（选做）改用 CloudWatch Agent 采集：应用只写本地文件、不再自己发送；hostSetup 安装 `amazon-cloudwatch-agent`，把 logging 片段
（只含 `logs.logs_collected.files`）渲染为 `cloudalbum-logging.json` 后 `append-config`。monitoring 的片段以后也追加到同一个 Agent。

:::method{kind=script default}
```bash {runsOn=workstation}
scripts/module enable logging --param Shipper=agent --dry-run
scripts/module enable logging --param Shipper=agent
```
:::

在实验机终端确认：

```bash {runsOn=lab}
systemctl status amazon-cloudwatch-agent --no-pager | head -5
sudo ls /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/
```

:::expected
Agent 是 `active (running)`；配置目录里有 `file_cloudalbum-logging.json`；logging 的 detail 写着“CloudWatch Logs（Agent 采集）”。
:::

:::warning
Agent 只用实例配置文件的凭证，不读 `secrets.env` 中的密钥：`IAM_CREDENTIALS=keys` 时 `Shipper=agent` 会被拒绝。
:::

::checks
