---
step: orient
---

First, get a clear view of the starting point: metrics and alarms both live inside the lab instance.

1. Open `/lab/m/monitoring` in the App preview on the right: every chart is labeled “数据来自 i-xxxx · 10 秒样本” (data from i-xxxx · 10-second samples), and the alarm panel's delivery path is “本地（实例宕机即失效）” (local — fails if the instance goes down).
2. In the lab terminal, look at the local evaluator's rules and state:

```bash {runsOn=lab}
sudo cat /etc/cloudalbum/alerts.yaml 2>/dev/null || echo "(file not found: using built-in default rules)"
curl -s http://127.0.0.1/api/capabilities | jq '.modules.monitoring | {driver, status, localHealth, detail}'
systemctl is-active amazon-cloudwatch-agent || true
```

:::expected
`driver` is `local`, `status` is `off` and `localHealth` is `ok`, and the detail contains “本地评估器 6 条规则” (local evaluator, 6 rules); the agent is not running (L0 does not install it).
:::

:::tip
`alerts.yaml` lives on the data volume (it moves with the data volume) and is not a runtime hot key; after you change it, the worker reads the new rules on its next evaluation.
:::

::checks
