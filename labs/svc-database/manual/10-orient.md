---
step: orient
---

在应用预览里浏览相册，然后在实验机终端看看数据库在哪里：

```bash {runsOn=lab}
curl -s -o /dev/null -D - "http://127.0.0.1/api/feed?limit=24" | grep -iE "^(x-cloudalbum-path|server-timing):"
curl -s http://127.0.0.1/api/capabilities | jq ".modules.database | {driver, status, detail}"
```

:::expected
路径头的 database 段是 `sqlite`；管理后台显示“SQLite（EBS 文件）”。
:::

:::why
**思考题**：如果停止这台 EC2，数据库会怎样？SQLite 与 EC2 同生共死——这一步卡片不实际执行（停机会中断平台管理通道），
留给你对照第 7 步的故障转移结果。
:::

::checks
