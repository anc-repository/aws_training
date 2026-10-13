---
step: orient
---

在**实验机终端**用 IMDSv2 读出实例角色的名字（只看名字，不打印凭证）：

```bash {runsOn=lab}
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/; echo
```

再看应用自己的凭证设置：

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq ".modules.iam | {driver, status, detail}"
```

:::expected
IMDS 返回角色名 `CloudAlbumAppRole`；应用的 iam 驱动是 `none`，状态 `off`。实例有角色，应用却没有在用。
:::

:::danger
不要请求 `iam/security-credentials/CloudAlbumAppRole`：那会把临时凭证打印到终端与历史记录里。
:::

::checks
