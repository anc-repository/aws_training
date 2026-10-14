---
step: blocklist
---

（选做）封禁 IP 与 Shield。

在管理后台 `/admin/security` 封禁一个文档保留地址（例如 `192.0.2.1`）：本地 `denylist.conf` 立即生效（Nginx reload），并同步到 us-east-1 的 IP 集合 `{{ var.ipSetName }}`。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/admin/security/blocklist | jq '{driver, ipSet, lastSync}'
```

读一读 **Shield Standard**（自动、免费，防网络 / 传输层 DDoS）与 **Shield Advanced**（付费，DDoS 响应团队、成本保护）的区别；多账户统一管理用 **Firewall Manager**。

:::expected
管理端点返回 `driver: aws`，并且 `lastSync.ok` 为 `true`——封禁已从本地 denylist 同步到 us-east-1 的 IP 集合。
:::
