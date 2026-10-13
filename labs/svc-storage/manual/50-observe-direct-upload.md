---
step: observe-direct-upload
---

在应用预览里再上传 3 张照片，在开发者工具中观察：上传分两步——先向本站要一个预签名 URL，再把文件 PUT 到 S3。

在工作台终端看看对象落在哪里：

```bash {runsOn=workstation}
aws s3api list-objects-v2 --bucket {{ var.rawBucket }} --prefix raw/ --max-items 5 --query "Contents[].[Key,Size]" --output table
```

:::expected
PUT 请求的主机是 `{{ var.rawBucket }}.s3.{{ session.region }}.amazonaws.com`，URL 带 `X-Amz-Signature`；
`raw/` 前缀下出现刚上传的对象；实验机的网卡几乎没有随上传增长的入流量。
:::

::checks
