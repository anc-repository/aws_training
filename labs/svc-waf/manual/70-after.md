---
step: after
---

记录 **after**：同一套攻击打向边缘（经 WAF），与第 2 步的 before 成对。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario flood --param target=both --param rate=8 --param duration=30
npm run exp -- waf --label after --scenario payloads --param target=both
```

对比要点：

- **限速**：Nginx 按秒、几乎立即、burst 精确；AWS WAF 按评估窗口聚合、有检测延迟（数十秒），放行数量不一定精确等于阈值。
- **源站负载**：攻击期间经 CloudFront 入口到达源站的请求数保持平稳——被拦截的请求不回源。
- **载荷识别**：AWS 托管规则组对编码变体的识别比 Nginx 的几条正则更强（`caughtOnlyByWaf` 列出 Nginx 漏掉而 WAF 拦住的变体）。
