---
section: wrap-up
---

## 你做到了什么

- 把照片从 EBS 数据卷搬进 S3，上传改为浏览器直传：实验机不再承载上传字节。
- 看懂了桶的安全基线（BPA、禁用 ACL、只允许 HTTPS、默认加密）与成本配置（版本控制、生命周期）。

## 考点回顾

- 预签名 URL 的有效期与签名凭证：临时凭证签名的 URL 会随凭证提前失效。
- Block Public Access、`BucketOwnerEnforced`、桶策略 `aws:SecureTransport`；SSE-S3、SSE-KMS 与 Bucket Key。
- 版本控制 + 生命周期；存储类别的最短存储期与最小计费尺寸。
- S3 事件通知 vs EventBridge；S3 网关终端节点不按小时计费。
