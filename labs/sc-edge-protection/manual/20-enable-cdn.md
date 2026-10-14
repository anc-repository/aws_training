---
step: enable-cdn
---

在实验机前面建 CloudFront 分配，并在同一次启用中**锁定直连入口**：80/443 只对管理员 IP——也就是工作台的公网出口
`{{ workstation.publicIp }}`——开放。CloudFront 回源到实验机的 8080 源站监听器，它只放行 CloudFront 托管前缀列表，Nginx 还会校验
一个只有本分配知道的 `X-Origin-Verify` 请求头。

:::why
**为什么建分配时就锁定，而不是先开着？** 这张卡片的目标是“任何流量都必须经过边缘的防护”。直连入口一旦开着，之后挂上的 WAF 就可以被绕过
（DEP-018）。管理员 IP 保留直连，是为了运维与第 8、9 步“直连 vs 边缘”的并排对照。
:::

:::method{kind=script default}
先看变更预览（cdn 栈、源站安全组，以及 ec2 基础栈的 `PublicHttpIngress=admin-ip`）：

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR={{ workstation.publicIp }}/32 --dry-run
```

确认后执行（脚本生成源站密钥、投放 8080 监听器、部署分配并等待部署完成）：

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR={{ workstation.publicIp }}/32
```
:::

:::tip
用 `--set`（写入 cdn 拥有的 `CDN_*` 键），不是 `--param`。`CDN_DIRECT_ACCESS=admin-ip` 而不给 `CDN_ADMIN_CIDR` 时，脚本会以退出码 2 拒绝执行。
:::

:::wait{typical=6 max=20}
分配状态从“正在部署”变为“已启用”需要几分钟。部署期间可以继续在应用预览里浏览相册；锁定生效后，预览会改用分配域名。
:::

::console-link[打开本会话的分配]{link=cloudfront.distribution distributionId="{{ var.distributionId }}"}

:::expected
cdn 的状态为“正常”；经分配请求 `/api/health/live` 时路径头以 `entry=cloudfront>nginx` 开头；源站是 `{{ target.publicDns }}:8080`，
仅 HTTP，并带 `X-Origin-Verify` 头。
:::

::checks
