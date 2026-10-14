---
step: orient
---

先看清起点：指标与告警都在实验机内部。

1. 在右侧“应用预览”打开 `/lab/m/monitoring`：每张图标注“数据来自 i-xxxx · 10 秒样本”，告警面板的送达路径是“本地（实例宕机即失效）”。
2. 在实验机终端看本地评估器的规则与状态：

```bash {runsOn=lab}
sudo cat /etc/cloudalbum/alerts.yaml 2>/dev/null || echo "（文件不存在：使用内置默认规则）"
curl -s http://127.0.0.1/api/capabilities | jq '.modules.monitoring | {driver, status, localHealth, detail}'
systemctl is-active amazon-cloudwatch-agent || true
```

:::expected
`driver` 为 `local`、`status` 为 `off`、`localHealth` 为 `ok`，detail 里有“本地评估器 6 条规则”；Agent 不在运行（L0 不安装它）。
:::

:::tip
`alerts.yaml` 在数据卷上（随数据卷迁移），不是运行时热键；修改后 worker 下一轮评估就会读到新规则。
:::

::checks
