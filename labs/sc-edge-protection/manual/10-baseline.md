---
step: baseline
---

先看清起点：`waf` 是实例上的 Nginx（`WAF_MODE=nginx`），`cdn` 没有启用，浏览器与攻击者都直接打实验机的弹性 IP。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules | {waf: .waf.driver, cdn: .cdn.driver}'
```

记录 **before** 的第一部分：从工作台对直连入口跑一个短轮次的限速攻击。运行器以略高于阈值的速率打 `POST /api/auth/login`（匿名、错误口令），
逐秒记录状态码，再以管理员身份读源站日志里本次 nonce 的计数。

```bash {runsOn=workstation}
npm run exp:login -w @cloudalbum/experiments
npm run exp -- waf --label before --scenario flood --param target=direct --param rate=8 --param duration=30 --upload
```

::experiment{module=waf id=flood label=before}

:::tip
`WAF_LAB_ALLOW_CIDR` 必须为空——它是 Allow 动作，会让白名单地址跳过全部规则。本卡全程不设置它。
:::

:::expected
Nginx 的 `limit_req` 几乎立即以 **429** 拦截（路径头 `waf=nginx:ratelimit`），但实验机的访问日志里出现了这一轮的每一个登录请求：
被拒绝的请求同样消耗了实例的连接、TLS 与日志。
:::

:::why
**“拦住了”不等于“没到达”。** Nginx 拒绝请求之前，TCP 握手、TLS 解密、请求解析都已经在 EC2 上完成；攻击量再大一点，
连 Nginx 自己都会成为瓶颈。这张卡片要把拦截点移到 CloudFront 边缘，让这些请求根本不进入东京区域。
:::

::checks
