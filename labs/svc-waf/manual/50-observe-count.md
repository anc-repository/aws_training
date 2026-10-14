---
step: observe-count
---

在 Count 模式下观察误杀。`false-positive` 以管理员身份经 CloudFront 发两个**合法但可疑**的请求：一个 >8 KB 的大请求体、一条含 `SELECT * FROM` 的正常文本。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario false-positive
```

到 **us-east-1** 的 CloudWatch Logs Insights（日志组 `{{ var.logGroup }}`）里看是谁命中了：

```sql
stats count() by terminatingRuleId, action
```

关键点：CRS 的 `SizeRestrictions_BODY`（8 KB）会误杀照片上传，所以本模块把它**覆盖为 Count**（不拦，只计数）。大请求体因此应当放行。
