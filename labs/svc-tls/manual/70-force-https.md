---
step: force-https
---

（选做，ACME 分支）让直连的 `http://` 跳转到 `https://`，并加上 HSTS。`max-age` 先用小值（300 秒），结束前一定要关闭。

:::method{kind=script default}
先看预览，再执行：

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }} --set TLS_FORCE_HTTPS=true --set TLS_HSTS_MAX_AGE=300 --dry-run
scripts/module enable tls --domain {{ learner.inputs.domain }} --set TLS_FORCE_HTTPS=true --set TLS_HSTS_MAX_AGE=300
```
:::

```bash {runsOn=workstation}
curl -sI http://{{ target.publicIp }}/ | grep -iE '^(HTTP|location)'
curl -sI https://{{ learner.inputs.domain }}/api/health/live | grep -i strict-transport
```

:::expected
第一条返回 `301` 与 `Location: https://…`；第二条返回 `Strict-Transport-Security: max-age=300`。回环地址（平台的本地检查）与
`/.well-known/acme-challenge/` 不跳转。
:::

:::danger
HSTS 会被浏览器记住 `max-age` 秒：在这段时间内浏览器拒绝回到 HTTP 或自签名证书。关闭 tls 之前先关闭它：

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }} --set TLS_FORCE_HTTPS=false
```
:::

::checks
