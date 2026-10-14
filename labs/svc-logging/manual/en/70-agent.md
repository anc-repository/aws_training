---
step: agent
---

(Optional) Switch to collection with the CloudWatch agent: the app only writes local files and no longer ships them itself; hostSetup installs `amazon-cloudwatch-agent`, renders the logging snippet
(containing only `logs.logs_collected.files`) as `cloudalbum-logging.json` and runs `append-config`. The monitoring snippet will later be appended to the same agent.

:::method{kind=script default}
```bash {runsOn=workstation}
scripts/module enable logging --param Shipper=agent --dry-run
scripts/module enable logging --param Shipper=agent
```
:::

Confirm in the lab terminal:

```bash {runsOn=lab}
systemctl status amazon-cloudwatch-agent --no-pager | head -5
sudo ls /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/
```

:::expected
The agent is `active (running)`; the configuration directory contains `file_cloudalbum-logging.json`; logging's detail says “CloudWatch Logs（Agent 采集）” (collected by the agent).
:::

:::warning
The agent only uses the instance profile's credentials and does not read the keys in `secrets.env`: with `IAM_CREDENTIALS=keys`, `Shipper=agent` is rejected.
:::

::checks
