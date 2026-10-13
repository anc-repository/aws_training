---
step: after
---

用与 before 相同的负载再测一次，这次全部经 CloudFront 访问（`target=cdn`）：

```bash {runsOn=workstation}
npm run exp -- cdn --label after --scenario media-load --param target=cdn --upload
```

::experiment{module=cdn id=media-load label=after}

:::expected
源站请求数与 EC2 出网字节明显下降（只剩未命中的回源请求）；报告中 before 与 after 两条结果都显示“有效”，并标注为可比的一对。
:::

:::saa{domain=cost}
从 AWS 源站（EC2、S3、ALB）回源到 CloudFront 的数据传输不收费；用户从 CloudFront 下载按 CloudFront 的出网计费（以官方定价为准）。
命中率越高，EC2 的出网流量越少。
:::

::checks
