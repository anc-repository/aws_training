---
step: orient
---

先看清起点：照片写在实验机的数据卷上，上传请求发往实验机自己。

1. 在右侧“应用预览”上传 1 张照片，在开发者工具的 Network 面板里找到上传请求：PUT 的目标是本站的 `/api/storage/upload`。
2. 在实验机终端看数据卷的使用情况：

```bash {runsOn=lab}
df -h /var/lib/cloudalbum
sudo du -sh /var/lib/cloudalbum/uploads
```

:::expected
上传请求的 `X-CloudAlbum-Path` 里有 `storage=local:write`；`/var/lib/cloudalbum/uploads` 下出现了刚上传的原图。
:::

::checks
