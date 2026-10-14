---
step: before-bench
---

先记录起始状态的 F14：测试用户 A 上传 10 个 12 MB 的 JPEG（分片 8 MB，每个文件 2 片），用的是应用自签的前缀令牌。

```bash {runsOn=workstation}
npm run exp -- identity-pool --label before --scenario upload-bench --upload
```

::experiment{module=identity-pool id=upload-bench label=before}

在应用预览里也试一次：打开“上传照片”，一次选两张照片（多文件走 F14），打开浏览器 DevTools 的网络面板。

:::expected
报告中 `mode=token`，`backendRequestsPerFile` 约为 2 + 分片数（建档、每片一次 `parts:sign`、complete）；
DevTools 里每个分片之前都有一个发往 EC2 的 `POST /api/uploads/parts:sign`，请求头是 `Authorization: CA-Upload …`；
响应头 `X-CloudAlbum-Path` 的 identity-pool 段是 `none:token`。
:::

:::tip
令牌放在请求头里而不是 URL 里：它不进访问日志、不进浏览器历史。它仍然只是应用自己的约定——泄露后在有效期内可以往该用户前缀写文件，
撤销要靠应用自己维护黑名单。
:::

::checks
