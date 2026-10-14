---
step: bypass-after
---

源站锁定后再验证一次：`bypass` 的 after 应当显示 `originLocked=true`。

上一步把直连入口只开放给了工作台（`CDN_ADMIN_CIDR={{ workstation.publicIp }}/32`），所以从工作台运行时直连**仍然可达**。
实验不只看客户端：它经直连请求 `/api/lab/echo`，取源站看到的客户端地址，与 capabilities 中 cdn 的 `adminCidr` 比较——
落在白名单内记为 `directAllowedAsAdmin=true`，不算“可绕过”；8080 不带合法 `X-Origin-Verify` 仍然必须被拒绝。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario bypass
```

现在白名单以外的地址无法直接打 EC2 绕过 CloudFront 上的 WAF，before 与 after 成对说明“锁定”起了作用。
想亲眼看到“其他地址被拒绝”，在 AWS CloudShell（不在白名单内）里 `curl -m 5 http://<实验机公网 IP>/api/health/live`，应当超时。
