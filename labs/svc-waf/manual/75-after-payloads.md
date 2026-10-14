---
step: after-payloads
---

记录 **after** 的第二部分：同一组载荷打向边缘（经 AWS WAF），与第 3 步的 before 成对。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario payloads --param target=both
```

AWS 托管规则组对编码变体的识别比 Nginx 的几条正则更强；结果里的 `caughtOnlyByWaf` 列出 Nginx 漏掉而 WAF 拦住的变体。
