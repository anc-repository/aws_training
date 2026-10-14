---
step: baseline
---

记录 **before**：纯 Nginx 的限速与特征拦截。从工作台对**直连**入口跑两个短轮次实验。

:::tip
`WAF_LAB_ALLOW_CIDR` 必须为空——它是 Allow 动作，会让白名单地址跳过全部规则（对 waf 自己的实验没有意义）。
:::

```bash {runsOn=workstation}
npm run exp -- waf --label before --scenario flood --param target=direct --param rate=8 --param duration=30
npm run exp -- waf --label before --scenario payloads --param target=direct
```

- `flood`：从单个来源以略高于阈值的速率打 `POST /api/auth/login`。Nginx 的 `limit_req` 几乎立即以 **429** 拦截（路径头 `waf=nginx:ratelimit`），但每个请求仍然到达实例。
- `payloads`：一组公开的 WAF 测试载荷。注意 Nginx 的几条正则会**漏掉**二次编码、大小写与注释变体。
