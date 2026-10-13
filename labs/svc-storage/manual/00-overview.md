---
section: overview
---

## 背景

你的相册只有一台 EC2：每张原图都要经 Nginx 流进 Node 进程，再写到 20 GiB 的数据卷上；同一块盘上还有 SQLite、日志和本地备份。
一群用户同时上传大图时，EC2 的网卡与 CPU 被上传占满，浏览时间线也跟着变慢；盘一满，连发评论（SQLite 写入）都会失败。
这张卡片把“存照片”交给 Amazon S3：浏览器拿一个预签名 URL 直接把文件传到 S3，EC2 只负责签名。

:::why
预签名 URL 是应用用自己的凭证对“某个对象键、某个操作、某个有效期”签名得到的 URL。浏览器拿着它直接 PUT 到 S3，字节不经过应用服务器；
S3 校验签名后接收对象。预签名 PUT 限制不了文件大小，所以应用在“上传完成”时用 `HeadObject` 再校验一次。
:::

## 对比实验预告

### 突发上传（storage/upload-burst，必做）

- **没有 S3（EBS + Node 落盘）**：10 个并发持续上传 5 MB 的图片，字节全部流经实验机的网卡与 Node 进程。
- **有了 S3**：同样的压测，浏览器（运行器）直接上传到 S3，实验机只签发 URL。
- **你会在哪里看到**：对比报告中实验机的网卡收字节（`host.net_rx_bytes`）不再随上传量增长；同时段 `GET /api/feed` 的 p95 基本不变；
  路径头从 `storage=local:write` 变为 `storage=s3:presign`。
- **如果结果不符合预期**：先确认 after 时 storage 的驱动已是 s3；再确认两次压测的参数相同（`--param fileMb=5`、`--duration 60s`）。
