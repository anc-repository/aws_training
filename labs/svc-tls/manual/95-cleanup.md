---
section: cleanup
---

- 平台删除 tls 栈：ACME 端点删除时一并删除 EAB、域验证与已注册的 ACME 账户；回退分支的 us-east-1 集成证书在 CloudFront 解除挂载后删除。
- 选做：结束前在实验机上吊销仍有效的 ACME 证书（ACM 的 `RevokeCertificate` 对它无效）：`scripts/module disable tls --param RevokeAcme=true`。
- 你在自己 DNS 中添加的 A 记录、验证 CNAME（以及回退分支的 CNAME）平台无权删除，请自己删掉。
- 开过 HSTS 的话，浏览器会在 `max-age` 内记住它：结束前先关闭 `TLS_FORCE_HTTPS`。
- 过期的 ACME 证书 ACM 会在一年后自动删除；在控制台用 ACME 过滤条件确认没有遗留。
