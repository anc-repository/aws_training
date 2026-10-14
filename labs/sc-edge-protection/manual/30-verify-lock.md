---
step: verify-lock
---

证明源站已经锁定。攻击者能走的路有三条：直连弹性 IP 的 80/443、直连 8080、伪造一个“来自 CloudFront”的请求。逐一看它们被什么挡住。

**1. 实验机安全组**：80/443 只剩管理员 IP。

```bash {runsOn=workstation}
aws ec2 describe-security-group-rules --filters Name=group-id,Values={{ target.sgId }} --query "SecurityGroupRules[?IsEgress==\`false\`].[FromPort,ToPort,CidrIpv4,CidrIpv6]" --output table
```

**2. 源站安全组**：8080 只引用 CloudFront 的托管前缀列表（`com.amazonaws.global.cloudfront.origin-facing`）。从工作台请求 8080 会超时：

```bash {runsOn=workstation}
aws ec2 describe-security-group-rules --filters Name=group-id,Values={{ var.originSgId }} --query "SecurityGroupRules[?IsEgress==\`false\`].[FromPort,PrefixListId]" --output table
curl -s -o /dev/null -m 8 -w "8080 from workstation: %{http_code}\n" "http://{{ target.publicIp }}:8080/api/health/live" || echo "8080 from workstation: timeout"
```

::console-link[打开实验机安全组]{link=ec2.securityGroup sgId="{{ target.sgId }}"}

**3. 前缀列表之外的第二道锁**：别人的 CloudFront 分配也来自这些网段，所以 Nginx 还要校验 `X-Origin-Verify`。安全组挡在前面，
这一层只能在实验机本机测到——不带校验头请求 8080：

```bash {runsOn=lab}
curl -s -o /dev/null -w "8080 without X-Origin-Verify: %{http_code}\n" http://127.0.0.1:8080/api/health/live
```

**4. 攻击者视角**：在一个**不是**管理员 IP 的地方直连实验机。打开 CloudShell（它的出口地址属于 AWS，不在你的安全组白名单里）：

::console-link[打开 CloudShell]{link=cloudshell.home}

```bash {runsOn=cloudshell}
curl -s -o /dev/null -m 8 -w "%{http_code}\n" "http://{{ target.publicIp }}/api/health/live" || echo timeout
curl -s -o /dev/null -m 8 -w "%{http_code}\n" "https://{{ var.cdnDomain }}/api/health/live"
```

:::expected
第 1 项只有 `{{ workstation.publicIp }}/32` 的 80 与 443；第 2 项只有一条 8080 + `pl-…` 的规则，工作台请求 8080 超时；
第 3 项返回 **403**；第 4 项直连超时，经分配返回 200。
:::

:::why
**为什么不直接跑 `waf/bypass` 实验？** 工作台的公网出口就是管理员 IP，从工作台探测 80 端口必然可达，实验会报“未锁定”。
判断“攻击者能不能绕过”要站在攻击者的位置（CloudShell），而“规则到底是什么”要看服务端的安全组配置，而不是某个客户端看到的响应。
:::

::checks
