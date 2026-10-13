---
step: private-bucket
---

证明桶仍然私有：同一个对象，直接请求桶被拒绝，经分配请求成功并在第二次命中缓存。

先从应用拿一张缩略图在桶中的键（`/media/` 之后的部分），记为 `KEY`：

```bash {runsOn=workstation}
KEY=$(aws s3api list-objects-v2 --bucket {{ var.mediaBucket }} --prefix variants/ --max-items 1 --query "Contents[0].Key" --output text)
echo "$KEY"
```

直接请求桶（不带签名）：

```bash {runsOn=workstation}
curl -s -o /dev/null -w "bucket: %{http_code}\n" "https://{{ var.mediaBucket }}.s3.{{ session.region }}.amazonaws.com/$KEY"
```

经分配请求两次：

```bash {runsOn=workstation}
for i in 1 2; do curl -s -o /dev/null -D - "https://{{ var.cdnDomain }}/media/$KEY" | grep -iE "^(HTTP/|x-cache|age):"; sleep 1; done
```

:::expected
直接请求桶返回 `403`；经分配的第一次 `200` + `Miss from cloudfront`，第二次 `200` + `Hit from cloudfront`（偶尔两次都是 Miss：两次 curl 可能落到不同的缓存主机，再运行一次）。
:::

:::why
**OAC 而不是公开桶。** CloudFront 以服务主体 `cloudfront.amazonaws.com` 签名读取对象，桶策略用 `AWS:SourceArn` 把放行限定到本分配；
其他分配、其他账号、任何直接请求都会被拒绝。对象使用 SSE-KMS 时，还要在密钥策略中允许该服务主体解密——这是 OAI 做不到的。
:::

::checks
