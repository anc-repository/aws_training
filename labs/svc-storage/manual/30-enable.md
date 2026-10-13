---
step: enable
---

启用 storage：模块部署原图桶与展示桶，在只读窗口内把已有照片迁移到 S3，再切换驱动、重启并跑深度探针。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable storage --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable storage
```
:::

:::wait{typical=3 max=15}
迁移期间应用处于只读窗口（可以浏览，不能上传）。迁移完成后在应用预览里上传 1 张照片，让平台看到一次真实的预签名上传。
:::

:::expected
storage 的状态为“正常”；媒体 URL 的主机是 `cloudalbum-{{ session.env }}-storage-（raw 或 media）-<账号>-<区域>.s3.{{ session.region }}.amazonaws.com`，带签名参数；
上传请求的路径头出现 `storage=s3:presign`。
:::

::checks
