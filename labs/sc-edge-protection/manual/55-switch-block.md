---
step: switch-block
---

观察没问题后，把托管规则组切到 **Block**。`modular-design` §9.2 没有 `set` 子命令——改一个参数就是以新参数重新 `enable`（栈更新）。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable waf --param RuleAction=block --dry-run
```

确认后执行（Web ACL 更新托管规则组动作，通常一两分钟生效）：

```bash {runsOn=workstation}
scripts/module enable waf --param RuleAction=block
```
:::

自己发一条载荷看看，再到实验机的访问日志里找它：

```bash {runsOn=workstation}
N=edge-$(date +%s); echo "$N"
curl -s -o /dev/null -w "%{http_code}\n" "https://{{ var.cdnDomain }}/api/public/now?q=1%27%20UnIoN%20SeLeCt%201&atlprobe=$N"
```

```bash {runsOn=lab}
sudo grep -c "atlprobe=<上一步打印的 N>" /var/lib/cloudalbum/logs/nginx-access.json
```

:::expected
请求返回 **403**，而实验机的访问日志里这条 nonce 的计数是 **0**——请求在边缘就被拦下，根本没有到达 EC2。
平台的检查会自动发一条带新 nonce 的载荷，用同样的方法核对。
:::

:::warning
托管规则组 Block 时返回的是 **CloudFront 的 403 页**，不带应用的 `X-CloudAlbum-Path`；Nginx 正则拦截时也是 403。
只看客户端响应头分不清是哪一层拦的，判断拦截位置一律以**源站是否收到请求**为准。
:::

::checks
