---
section: overview
---

## 背景

你的相册部署在东京的一台 EC2 上：每一张缩略图、每一个 JS 文件都由这台机器的 Nginx 发出。海外用户打开相册时，每个字节都要跨洋往返；
访问量一大，EC2 的网卡和出网流量费用都跟着涨。这张卡片在 EC2 前面加一层 Amazon CloudFront，让同样的内容从离用户最近的边缘节点返回，
命中缓存时根本不回源。

:::why
CloudFront 的自定义源站只接受域名，所以分配回源到实验机的公网 DNS。为了让“只有你的分配”能访问源站，模块在实验机上开了一个只给
CloudFront 用的 8080 监听器：安全组只放行 CloudFront 的托管前缀列表，Nginx 还会校验一个只有你知道的 `X-Origin-Verify` 请求头。
:::

## 对比实验预告

### 源站负载（cdn/media-load，必做）

- **没有 CloudFront（EC2 直出）**：工作台持续加载相册与缩略图，每个请求都到达 EC2 的 Nginx。
- **有了 CloudFront**：同样的负载经分配访问，命中缓存的请求不再回源，EC2 只处理未命中的那部分。
- **你会在哪里看到**：对比报告中的源站请求数（`server.origin`）与 EC2 出网字节（`host.net_tx_bytes`）下降；响应头 `X-Cache` 从无到
  `Hit from cloudfront`；`X-CloudAlbum-Path` 的 `entry` 从 `nginx` 变为 `cloudfront>nginx`。
- **如果结果不符合预期**：先确认 after 那次带了 `--param target=cdn`；再确认分配状态已是“已部署”。

### 首字节时间与压缩（cdn/ttfb、cdn/compression，选做）

工作台与实验机同在东京，首字节时间的差别很小，只作参考；压缩实验看 JS、CSS 经 CloudFront 时的 `Content-Encoding: br`。

## 平台模式说明

本卡用 `scripts/module enable cdn` 一键创建分配（路线 S）。平台通过本会话的 cdn 模块栈确认分配属于你；检测时平台会自己请求分配域名、
核对对端 IP 属于 CloudFront 的地址段，并到源站日志里数请求次数，所以浏览器里看到的响应头只用于观察，不作为完成依据。
