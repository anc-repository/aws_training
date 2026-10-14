# tls 实验（有 / 无 ACM）

设计：[docs/modules/01-edge-network-scaling.md#tls](../../docs/modules/01-edge-network-scaling.md) 第 5 节。**人工前置：自有域名**，并能在它的
DNS 中添加 CNAME（ACME 域验证或 ACM DNS 验证）与 A 记录（→ EIP）。

| 标签 | 前置条件 |
|---|---|
| `before` | `tls.driver=selfsigned`（L0）或 `letsencrypt`（本地档） |
| `after` | `tls.driver=acm`、`tls.status=ok/degraded` |

被测入口缺省从 capabilities 读取：直连（`ec2.data.publicIpv4`，SNI 用 `tls.data.domain`）、CDN（`cdn.public.baseUrl`）、https 的有效入口 URL；
也可以 `--param hosts=direct=203.0.113.10,cdn=d111.cloudfront.net` 指定。所有实验都附带服务端证据 `server`：`capabilities.https`（受信 HTTPS
判定）与 tls 感知器在实例上对 `127.0.0.1:443` 等入口的握手结果（不是只看客户端）。

## inspect

```bash
npm run exp -- tls --label before --scenario inspect
scripts/module enable tls --domain album.example.com          # 仓库根目录；ACME 端点不可用或 --no-acme 时走回退分支
npm run exp -- tls --label after  --scenario inspect --upload
```

每个入口一次全新握手：签发者、主题、SAN、有效期与剩余天数、协议、套件、ALPN、链是否受信任（`kind`：selfsigned / letsencrypt / amazon /
cf-default），以及经该入口请求 `/api/health/live` 时 `X-CloudAlbum-Path` 的 `tls` 段（`selfsigned@nginx`、`acm@nginx:acme`、`acm@cloudfront`、
`selfsigned@cloudfront:cf-default`）。等价的手工命令：

```bash
openssl s_client -connect <EIP>:443 -servername album.example.com </dev/null 2>/dev/null | openssl x509 -noout -issuer -subject -dates -ext subjectAltName
```

浏览器检查（步骤 2）：打开 `https://<EIP>/` 记录拦截页；`/lab` 的“跨源 fetch 测试”在自签名下失败。

## handshake

```bash
npm run exp -- tls --label after --scenario handshake --param samples=20 --upload   # 选做：us-east-1、eu-west-1、ap-southeast-2、ap-northeast-1 的 CloudShell
```

每次新建连接，TLS 握手耗时（= curl 的 `time_appconnect - time_connect`）与 TCP 连接耗时的中位数；`cdnVsDirectHandshakeRatio` < 1 表示经
CloudFront 更快（远端区域明显，东京本地差别不大）。

## cipher-scan

```bash
sudo dnf install -y nmap
npm run exp -- tls --label after --scenario cipher-scan
```

`nmap --script ssl-enum-ciphers -p 443 <host>`：各协议版本的套件与最低强度等级。Nginx 只开 TLSv1.2 / TLSv1.3；CloudFront 的最低协议由
`TLSv1.2_2021` 安全策略决定。只扫描自己账号里的资源。

## renew-drill

```bash
npm run exp -- tls --label after --scenario renew-drill --fault-via ssm --upload       # L0 用 --fault-via ssh --ssh ec2-user@<EIP>
```

第 5 秒在实例上执行 `faults/renew-drill.sh`（tls hostSetup 的 `renew-drill --force`：`certbot renew --dry-run`，再 `--force-renewal`；
ACME 证书每次签发按证书中的域名计费一次）。脚本轮询直连入口直到证书序列号变化（`secondsToNewCert`），确认新证书真的装进了 Nginx；
同一 ACME 账户以相同域名与密钥算法续期时 ACM 中的证书 ARN 不变（在 ACM 控制台用 ACME 过滤条件查看）。集成证书（CloudFront / ALB）由 ACM
托管续期，`aws acm describe-certificate` 给出 `RenewalEligibility`、`InUseBy` 与验证记录状态（`integration`）。
