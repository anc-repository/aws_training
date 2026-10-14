---
step: observe-count
---

新启用托管规则组时先 Count、读真实流量里的 COUNT 记录、确认没有误杀，再改 Block。`false-positive` 以管理员身份经 CloudFront 发两个
**合法但可疑**的请求：一个大于 8 KB 的请求体，一条含 `SELECT * FROM` 的正常文本。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario false-positive --upload
```

::experiment{module=waf id=false-positive label=after}

再在应用预览里上传一张照片（`storage` 保持本地，照片经 `/api/storage/upload` 以大请求体上传）。然后到 **us-east-1** 的
CloudWatch Logs Insights，选择日志组 `{{ var.logGroup }}`，看是谁命中了：

```sql
fields @timestamp, httpRequest.uri, action, terminatingRuleId
| sort @timestamp desc
| limit 50
```

模块只把 BLOCK 与 COUNT 记录投递到日志组。展开一条上传请求的记录，在 `ruleGroupList` 里找 `AWSManagedRulesCommonRuleSet`：
命中的 `SizeRestrictions_BODY` 出现在“不终止”的匹配规则里，动作是 COUNT。也可以在 WAF 控制台的“采样请求”里按规则筛选。

:::expected
大请求体与照片上传都成功：CRS 的 `SizeRestrictions_BODY` 在模板中被**规则动作覆盖**为 Count，只计数不拦截；
含 SQL 关键字的正常文本此刻也只是计数（托管规则组整体还是 Count）。
:::

:::why
**为什么只覆盖一条规则？** 删除整个核心规则集会放弃全部 OWASP 类防护；规则动作覆盖（或给上传路径加范围缩小语句）只放过误杀的那一条，
其余规则保持生效。
:::

::checks
