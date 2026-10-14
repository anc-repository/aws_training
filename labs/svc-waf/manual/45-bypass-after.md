---
step: bypass-after
---

源站锁定后再验证一次：`bypass` 的 after 应当显示直连**不可达**（`originLocked=true`）。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario bypass
```

现在攻击者无法直接打 EC2 绕过 CloudFront 上的 WAF，before 与 after 成对说明“锁定”起了作用。
