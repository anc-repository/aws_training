---
step: two-columns
---

在 ACM 控制台的证书列表里，用“密钥对来源：ACME”筛选（不筛选时 ACME 证书默认不显示），看这张证书的来源与续期方式。

| | 考试结论（SAA 题库的常见答案） | 2026 新能力（本卡 ACME 分支） |
|---|---|---|
| ACM 证书能否装到 EC2 | **不能**：私钥由 ACM 托管、不可导出，只挂在 CloudFront、ALB、API Gateway 上 | ACME 端点签发 45 天证书，私钥在实例上，装到 Nginx |
| 续期 | ACM 托管自动续期（DNS 验证记录必须保留） | 客户端（certbot 定时器）续期，ACM 不负责 |
| 能否挂到 CloudFront / ALB | 能（CloudFront 用 us-east-1 的证书） | **不能** |

:::expected
ACME 证书的“密钥对来源”是 ACME，没有“托管续期”；它不能被选作 CloudFront 分配的自定义证书。
:::

:::saa{domain=secure}
答题时以左栏为准：“在 EC2 上为 ACM 证书终止 TLS”的标准答案是在前面加 ALB / CloudFront，或导入第三方证书。
:::

::checks
