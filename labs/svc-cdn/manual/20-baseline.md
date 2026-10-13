---
step: baseline
---

在启用 CloudFront 之前，先记录“EC2 直出”时的源站负载，作为对比的 before。

运行器会持续 5 分钟加载相册 JSON、30 张缩略图与 1 张展示图，并把结果上传到平台：

```bash {runsOn=workstation}
npm run exp -- cdn --label before --scenario media-load --upload
```

::experiment{module=cdn id=media-load label=before}

:::expected
运行结束时打印 `runId` 与 `== cdn/media-load · before`；平台在几十秒内完成交叉核验，检查变为“通过”。
:::

:::tip
运行期间可以打开实验机终端执行 `sudo tail -f /var/lib/cloudalbum/logs/nginx-access.json | jq -c '{uri, status}'`，看请求全部打到 Nginx。
:::

::checks
