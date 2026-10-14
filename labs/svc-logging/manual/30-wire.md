---
step: wire
---

接入 CloudWatch Logs。模块会创建日志组 `/cloudalbum/{{ session.env }}/app` 与 `/nginx`（保留 14 天）、指标过滤器
`AppErrors`、`Nginx5xx`、`AuthLoginFailed`（命名空间 `CloudAlbum/Logs`）与 4 条保存的 Logs Insights 查询，附加实例策略后重启 api 与 worker。

:::method{kind=script default}
先看变更预览（`LOG_CW_SHIPPER=sdk`：应用自己批量发送）：

```bash {runsOn=workstation}
scripts/module enable logging --param RetentionInDays=14 --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable logging --param RetentionInDays=14
```
:::

:::wait{typical=3 max=10}
部署日志组与指标过滤器不到一分钟；重启后发送器每 2 秒（`LOG_CW_FLUSH_MS`）发送一批。平台随后请求一次实验机，并确认本实例的
`<实例 ID>/access` 日志流出现在 Nginx 日志组里。
:::

::console-link[在 CloudWatch 控制台打开 Nginx 日志组]{link=logs.group logGroupEncoded="{{ var.nginxGroup | url }}"}

:::expected
logging 的驱动为 `cloudwatch`、状态正常，detail 写着“CloudWatch Logs · /cloudalbum/{{ session.env }}/app · 流 <实例 ID>/api …”；
两个日志组的保留期都是 14 天；本地文件仍然照写。
:::

:::saa{domain=cost confusable="保留期"}
日志组默认**永不过期**，存储费只增不减；一定要设置保留期。日志类别（Standard / Infrequent Access）创建后不能改，本模块统一用 Standard。
:::

::checks
