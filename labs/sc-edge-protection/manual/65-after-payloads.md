---
step: after-payloads
---

记录 **after** 的第二部分：同一组载荷同时打向直连与边缘，与第 2 步的 before 成对。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario payloads --param target=both --upload
npm run exp:report -- waf --experiment payloads
```

::experiment{module=waf id=payloads label=after}

:::expected
边缘一侧拦住的载荷不少于直连一侧，尤其是编码与大小写变体；`caughtOnlyByWaf` 列出 Nginx 漏掉而托管规则组拦住的变体。
被托管规则组拦截的请求返回 CloudFront 的 403，同样不进入源站日志。
:::

:::tip
托管规则组由 AWS 持续更新，同一组载荷在不同时间的结果可能略有差别；这正是它与手写正则的区别。
:::

::checks
