---
step: orient
---

先看清起点：日志只是数据卷上的文件，只有这一台实例。

在实验机终端执行：

```bash {runsOn=lab}
sudo ls -l /var/lib/cloudalbum/logs/
sudo tail -n 3 /var/lib/cloudalbum/logs/nginx-access.json | jq -c '{ts, rid, uri, status}'
curl -s http://127.0.0.1/api/capabilities | jq '.modules.logging | {driver, status, localHealth}'
```

:::expected
目录里有 `api.log`、`worker.log`、`nginx-access.json`（以及 logrotate 轮转出的 `.1`、`.gz`），属主 `cloudalbum`、权限 `0640`；
logging 的驱动是 `file`、状态 `off`（本地实现健康）。Nginx 的 `rid` 就是响应头 `X-CloudAlbum-Request-Id`，应用日志里叫 `requestId`。
:::

:::tip
想象一下：这台实例明天被替换（例如 Auto Scaling 缩容），这些文件还在吗？要查“过去一小时哪个接口 5xx 最多”，你会怎么写命令？
:::

::checks
