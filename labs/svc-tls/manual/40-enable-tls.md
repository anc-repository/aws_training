---
step: enable-tls
---

:::method{kind=script default}
先看变更预览（不调用任何会改变资源的 API）：

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }} --dry-run
```

确认后执行（本账号有该域名的 Route 53 托管区域时加 `--zone-id <ID>`，验证记录会自动创建）：

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }}
```
:::

### ACME 分支（变体 `default`）

脚本依次：部署 tls 栈（ACME 端点、预先批准的域验证、签发角色 `cloudalbum-{{ session.env }}-acme-issuer`）→ 打印**域验证 CNAME** →
等待它变为 `VALID` → 创建 1 天有效的 EAB → 经投递通道在实验机上运行 certbot 完成注册与签发（客户端超时 120 秒）→ 删除 EAB →
投递 `tls.env`，hostSetup 把 `/etc/cloudalbum/tls/server.*` 切到新证书并 reload Nginx。

:::wait{typical=5 max=30}
把脚本打印的 CNAME 添加到你的 DNS，并**一直保留**：它是持久的预先批准验证，删掉后新的签发与续期都会失败。
**为什么 80 端口不必对公网开放？** `PRE_APPROVED` 的域验证在申请证书之前就完成了，certbot 申请时没有在线挑战；
Let's Encrypt 的 HTTP-01 则要求 80 端口可达。
:::

确认 Nginx 换了证书：

```bash {runsOn=lab}
openssl s_client -connect 127.0.0.1:443 </dev/null 2>/dev/null | openssl x509 -noout -issuer -ext subjectAltName -dates
```

:::expected
签发者是 Amazon，SAN 是 `DNS:{{ learner.inputs.domain }}`，有效期约 45 天。浏览器打开 `https://{{ learner.inputs.domain }}/` 显示锁标志。
:::

### 回退分支（变体 `acme-off`）

脚本在 **us-east-1** 部署 tls-edge 栈申请集成证书（DNS 验证），把证书与备用域名注入 cdn 栈。没有托管区域时 CloudFormation 会等待验证：
到 ACM 控制台（切换到美国东部（弗吉尼亚北部））查看验证 CNAME 并添加到你的 DNS。完成后把 `{{ learner.inputs.domain }}` 从 A 记录改为
CNAME 到分配的默认域名：

::console-link[打开本会话的 CloudFront 分配]{link=cloudfront.distribution distributionId="{{ envfile.cdn.CDN_DISTRIBUTION_ID }}"}

:::expected
分配的“备用域名”是你的域名，“自定义 SSL 证书”来自 us-east-1；`https://{{ learner.inputs.domain }}/` 显示锁标志，路径头 `entry=cloudfront>nginx`。
实验机直连 443 仍是自签名证书——ACM 证书只挂在 CloudFront 上（考试结论）。
:::

::checks
