---
step: after
---

记录 **after**：与第 1 步相同的限速攻击，这次同时打两条路径——直连（工作台是管理员 IP，仍然可达，作为并排对照）与经 CloudFront 的边缘入口。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario flood --param target=both --param rate=8 --param duration=30 --upload
npm run exp:report -- waf
```

::experiment{module=waf id=flood label=after}

:::expected
- **直连**：仍然是 Nginx 的 429，几乎立即生效，每个请求都记在实例上。
- **边缘**：前几十秒的请求照常通过（速率规则按评估窗口聚合、有检测延迟），之后被 `rate-login` 以 429 拦截（路径头 `waf=aws:block-rate-login`）；
  被拦截的那部分不再出现在源站日志里，源站收到的请求数在攻击期间保持平稳。
:::

:::saa{domain=resilient confusable="Nginx limit_req vs WAF 速率规则"}
`limit_req` 按秒、精确、每台实例各自计数（多实例时限额被放大）；WAF 基于速率的规则在边缘按窗口统计、全局计数，有检测延迟，
在 CloudFront 后面按真实客户端 IP（或 `X-Forwarded-For`）聚合。两者常常配合使用：边缘挡大头，源站兜底。
:::

::checks
