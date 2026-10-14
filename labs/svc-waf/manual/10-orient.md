---
step: orient
---

先看清起始状态：`waf` 还是本地实现（`WAF_MODE=nginx`），`cdn` 已经启用，但直连入口**没有锁定**（`CDN_DIRECT_ACCESS=open`）——
故意如此，好让你在第 2、3 步亲眼看到“可以绕过 WAF”。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules | {waf: .waf.driver, cdn: .cdn.driver}'
```

本卡的 WAF 挂在 **CloudFront** 上（CLOUDFRONT 范围）：Web ACL、IP 集合、日志组都在 **us-east-1**，和东京的应用区域分开。

:::expected
`waf` 的驱动是 `nginx`，`cdn` 的驱动是 `cloudfront`。这说明限速与拦截还在实例上，边缘还没有 WAF。
:::
