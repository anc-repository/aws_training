---
step: switch-block
---

观察没问题后，把托管规则组切到 **Block**。

:::tip
`modular-design §9.2` 没有 `set` 子命令——“改一个参数”就是以新参数重新 `enable`（栈更新，附录 B-27）。
:::

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable waf --param RuleAction=block --dry-run
```

确认后执行（Web ACL 更新托管规则组动作）：

```bash {runsOn=workstation}
scripts/module enable waf --param RuleAction=block
```
:::

:::expected
托管规则组的 `OverrideAction` 变为 `None`（自带的 Block 动作生效）；检查会自动发一条带 nonce 的载荷，确认它返回 403 且**没有到达源站**（源站日志里这条 nonce 的计数为 0）。
:::

:::warning
托管规则组 Block 返回的是 **CloudFront 的 403**，不带应用的 `X-CloudAlbum-Path` 头——所以单看客户端响应头无法把它和 Nginx 正则的 403 区分开。判断“拦在边缘”要靠服务端证据：源站根本没收到这条请求。
:::
