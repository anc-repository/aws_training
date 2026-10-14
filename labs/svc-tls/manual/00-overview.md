---
section: overview
---

## 背景

L0 的 443 用的是 User Data 生成的自签名证书（`CN=cloudalbum-l0`）：流量虽然加密，浏览器却显示“不安全”，跨源 fetch 与 Cognito 回调都会失败。
AWS Certificate Manager 有两种给证书的方式：**集成证书**挂在 CloudFront、ALB、API Gateway 上，私钥由 ACM 托管、不可导出、自动续期；
2026-07 起，ACM 的 **ACME 端点**可以给自管服务器签发 45 天的公有证书，私钥留在实例上，由 certbot 续期。

:::warning
**人工前置：自有域名**，并能在它的 DNS 中添加 CNAME（ACME 域验证或 ACM 的 DNS 验证）与 A 记录（指向实验机 EIP）。ACM 不能为 IP、
`amazonaws.com` 或 `cloudfront.net` 名称签发证书。本账号已有该域名的 Route 53 托管区域时，可以用 `--zone-id` 让验证记录自动创建。
没有域名时本卡无法完成：`scripts/module enable tls` 打印提示并以退出码 2 结束，不部署任何东西。
:::

:::saa{domain=secure}
**考试结论**：ACM 公有证书不能装到 EC2，只能挂在集成服务上；CloudFront 用的证书必须在 us-east-1。
**2026 新能力**：ACME 端点 + 预先批准的 DNS 域验证 + EAB，证书装到自管服务器；这类证书反过来不能挂到 CloudFront 或 ALB。答题以考试结论为准。
:::

## 对比实验预告

### 各入口的证书（tls/inspect，必做）

- **没有 ACM**：直连 `https://<EIP>/` 的证书由 `CN=cloudalbum-l0` 自签名，链不受信任；路径头 `tls=selfsigned@nginx`。
- **有了 ACM**：ACME 分支的直连证书由 Amazon 签发、SAN 含你的域名、约 45 天；回退分支在 CloudFront 的备用域名上看到 us-east-1 的集成证书。
- **你会在哪里看到**：对比报告中各入口的签发者、SAN、剩余天数与 `trustedEntries`；服务端证据是实验机上的 tls 感知器对 `127.0.0.1:443`
  的握手结果与 `capabilities.https`。
- **如果结果不符合预期**：先看 tls 的状态详情——“签发者不是 Amazon”说明证书符号链接没有切换或 Nginx 没有 reload。

### 续期演练（tls/renew-drill，ACME 分支）

`certbot renew --dry-run` 与 `--force-renewal`：新证书装进 Nginx，ACM 中的证书 ARN 不变（同一 ACME 账户、相同域名与密钥算法）。

## 平台模式说明

本卡关闭了平台的方案 B 预览（Let's Encrypt IP 证书），预览在新标签页打开 `http://<EIP>`。平台在开始前用账号预检判断 ACME 端点是否可用，
并选好起始变体（当前：`{{ session.variant }}`）：`default` 走 ACME 分支；`acme-off` 起始状态另带 CloudFront 分配，走回退分支。
