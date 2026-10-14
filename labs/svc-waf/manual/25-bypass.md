---
step: bypass-before
---

源站还没锁定，先看“能不能绕过”。`bypass` 直接请求实验机的直连入口与 8080：

```bash {runsOn=workstation}
npm run exp -- waf --label before --scenario bypass
```

此刻直连可达（`originLocked=false`）：就算之后把 WAF 挂上 CloudFront，攻击者也能直接打 EC2 绕过它。这正是 **DEP-018** 警告的现象，第 4 步会修好。
