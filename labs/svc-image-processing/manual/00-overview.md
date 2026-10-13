---
section: overview
---

## 背景

L0 的缩略图在“上传完成”请求内由 sharp 同步生成（inline，并发 2）。批量上传 200 张时，请求在信号量上排队，两个 vCPU 被占满，
浏览时间线也跟着卡，队尾请求甚至可能被 Nginx 截成 504。这张卡片让原图一落进 S3，就由 EventBridge 异步调用 Lambda 生成缩略图；
EC2 只负责把结果写回数据库。

:::why
Lambda 读不到实验机的 EBS 与 SQLite：一旦把计算交给 Lambda，输入必须在 S3、结果必须经网络写回。
所以起始状态已经预置了 storage(s3)，回写走本模块自带的结果队列（不需要任何入站流量）。
:::

## 对比实验预告

### 上传突发（image-processing/upload-burst，必做）

- **没有 Lambda（inline）**：complete 接口的耗时 = sharp 处理时间，并发 20 时到秒级；EC2 CPU 被打满。
- **有了 Lambda**：complete 只做一次数据库更新，几十毫秒量级；EC2 CPU 几乎是一条平线；缩略图大多在几秒内就绪。
- **你会在哪里看到**：对比报告中 `POST /api/photos/complete` 的 p95、`host.cpu.p95` 与 `biz.photo_time_to_ready.p95`；
  响应头 `X-CloudAlbum-Path` 从 `image-processing=inline` 变为 `image-processing=lambda:async`。
- **如果结果不符合预期**：确认 after 运行时 image-processing 的驱动是 lambda、状态正常；首批照片包含冷启动，就绪时间会偏长。

### 失败路径（image-processing/failures，必做）

损坏的 JPEG 是永久错误：函数直接回写 FAILED，不重试、不进失败队列。

## 平台模式说明

对比实验在工作台运行。函数的部署包由 `scripts/module` 打包后上传到平台预先创建的工具链桶，你不需要安装打包工具。
