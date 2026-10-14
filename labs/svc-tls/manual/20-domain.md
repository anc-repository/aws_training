---
step: domain
---

在你的 DNS 中为 `{{ learner.inputs.domain }}` 添加一条 A 记录指向实验机 `{{ target.publicIp }}`（浏览器靠它找到实验机），然后确认：

```bash {runsOn=workstation}
dig +short {{ learner.inputs.domain }} @8.8.8.8
```

:::expected
输出 `{{ target.publicIp }}`。DNS 修改的生效时间取决于你的 DNS 服务商与记录原来的 TTL。
:::

**回退分支（变体 `acme-off`）还要多做一件事**：DEP-005 ③ 要求“dns 或外部 DNS”，用外部 DNS 的本地档把应用的有效入口改为你的域名
（不部署任何 AWS 资源，不写 `MODULE_DNS=on`）：

```bash {runsOn=workstation}
scripts/module enable dns --driver external --domain {{ learner.inputs.domain }}
```

:::warning
回退分支在第 4 步会把这个名字改成 CNAME 到 CloudFront 分配：同一名称不能同时有 A 与 CNAME；外部 DNS 的区域顶点不能建 CNAME，
所以回退分支必须用子域（例如 `lab.example.com`）。
:::

::checks
