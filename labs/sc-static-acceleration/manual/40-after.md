---
step: after
---

记录 after：与第 1 步相同的媒体加载，这次缩略图来自边缘。

```bash {runsOn=workstation}
npm run exp -- cdn --label after --scenario media-load --upload
```

::experiment{module=cdn id=media-load label=after}

:::expected
源站请求数与出网字节明显下降，只剩未命中的回源；`/lab` 的“源站负载”面板中带 `X-Amz-Cf-Id` 的回源请求占比很小。
:::

:::saa{domain=performance confusable="CloudFront vs Global Accelerator vs S3 Transfer Acceleration"}
CloudFront 在边缘缓存内容；Global Accelerator 提供静态 Anycast IP 与骨干网加速，不缓存，端点是 ALB、NLB、EC2 与弹性 IP；
S3 Transfer Acceleration 加速客户端与桶之间的长距离传输（多用于上传），也不缓存。
:::

::checks
