---
step: enable-waf
---

把 AWS WAF 挂到分配上。模块会在 **us-east-1** 创建 Web ACL（CLOUDFRONT 范围）、IP 集合 `cloudalbum-blocklist` 与日志组
`{{ var.logGroup }}`，再把 `WebAclArn` 注入 cdn 栈，分配随之重新部署。托管规则组先用 **Count**（只计数、不拦截）。

:::method{kind=script default}
先看变更预览（注意栈名 `cloudalbum-{{ session.env }}-waf-edge` 与区域 us-east-1）：

```bash {runsOn=workstation}
scripts/module enable waf --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable waf
```
:::

:::wait{typical=6 max=20}
先部署 us-east-1 的 Web ACL，再更新 cdn 栈；分配重新部署完成之前，waf 可能短暂显示“Web ACL 未关联？”，这是预期的等待。
:::

启用脚本还会把实例上的 `denylist.conf` 首次全量导入 IP 集合。完成后在实验机上确认状态，并从工作台经分配请求一次：

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.waf | {driver, status, detail}'
```

```bash {runsOn=workstation}
curl -sI "https://{{ var.cdnDomain }}/api/health/live" | grep -i "^x-cloudalbum-path:"
```

到 WAF 控制台（区域选 **Global (CloudFront)**）看一看规则顺序、每条规则的 WCU 与“采样请求”：

::console-link[打开 WAF Web ACL 列表]{link=wafv2.webAcls}

:::expected
waf 为“正常”（源站已经锁定，没有 DEP-018）；路径头以 `entry=cloudfront>waf>nginx` 开头——Web ACL 的默认动作给放行的请求插入
`x-amzn-waf-cloudalbum`，Nginx 据此在入口链里写上 waf；分配的 WebACLId 是本会话 Web ACL 的 ARN。
:::

:::saa{domain=secure confusable="WAF 的两种范围"}
CLOUDFRONT 范围的 Web ACL、IP 集合、规则组都只能在 us-east-1 创建；REGIONAL 范围（ALB、API Gateway、AppSync、Cognito User Pool）
建在资源所在的区域。在 ap-northeast-1 建的 Web ACL 不会出现在分配的下拉框里。
:::

::checks
