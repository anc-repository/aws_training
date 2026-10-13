---
step: enable-cdn
---

CloudFront 的自定义源站只接受**域名**。我们让分配回源到实验机的 **8080 源站监听器**：
这个端口只给 CloudFront 用，安全组只放行 CloudFront 的托管前缀列表，Nginx 还会校验一个只有你知道的请求头。

:::why
只放行前缀列表不够——别人的 CloudFront 分配也来自同一批网段。`X-Origin-Verify` 才能证明请求来自“你的”分配。
:::

:::method{kind=script default}
一键脚本会生成源站密钥、投放 8080 监听器、部署分配与源站安全组、等待部署完成，再把媒体 URL 改写到 CloudFront。先看变更预览：

```bash {runsOn=workstation}
scripts/module enable cdn --dry-run
```

确认后执行（会等待分配部署完成，通常需要几分钟）：

```bash {runsOn=workstation}
scripts/module enable cdn
```
:::

:::wait{typical=5 max=20}
**为什么回源用 8080，而不是 80？** 80/443 给浏览器直连用；8080 只给 CloudFront 用，安全组只对 CloudFront 的托管前缀列表开放。
分配部署期间，可以在右侧“应用预览”里继续浏览相册——现在一切仍由 EC2 直出。
:::

部署完成后，在控制台看一看这个分配的源站与行为：

::console-link[打开本会话的 CloudFront 分配]{link=cloudfront.distribution distributionId="{{ var.distributionId }}"}

:::expected
cdn 的状态为“正常”；分配状态为“已启用”；源站为 `{{ target.publicDns }}:8080`，协议为仅 HTTP，带 `X-Origin-Verify` 头；
不带校验头直接访问 8080 返回 403。
:::

:::warning
不要在控制台修改模块管理的分配（源站、行为、策略）：平台把它们当作本卡的完成证据，`scripts/module` 的下一次更新也会覆盖你的修改。
:::

::checks
