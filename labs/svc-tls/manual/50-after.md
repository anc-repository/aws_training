---
step: after
---

用与 before 相同的方式再测一次：

```bash {runsOn=workstation}
npm run exp -- tls --label after --scenario inspect --upload
```

::experiment{module=tls id=inspect label=after}

:::expected
受信任的入口数（`trustedEntries`）增加：ACME 分支的直连入口变为 Amazon 签发；回退分支的 CloudFront 备用域名使用 us-east-1 的集成证书。
报告中 before 与 after 标注为可比的一对。
:::

**ACME 分支：续期演练。** 第 5 秒在实验机上执行 `certbot renew --dry-run`，再 `--force-renewal`（多签发一次，按域名计费）：

```bash {runsOn=workstation}
npm run exp -- tls --label after --scenario renew-drill --fault-via ssm --upload
```

::experiment{module=tls id=renew-drill label=after}

:::expected
`renewed` 为 true，`secondsToNewCert` 在两分钟左右：新证书（序列号变化）真的装进了 Nginx。在 ACM 控制台用 ACME 过滤条件查看，
证书 ARN 不变（同一 ACME 账户、相同域名与密钥算法）。
:::

:::tip
选做：在 4 个区域的 CloudShell 运行 `--scenario handshake`，比较经 CloudFront 与直连的 TLS 握手耗时；`--scenario cipher-scan` 需要 nmap。
:::

::checks
