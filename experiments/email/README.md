# email 实验（有 / 无 SES）

设计：[docs/modules/04-compute-async.md#email](../../docs/modules/04-compute-async.md) 第 5 节。

| 标签 | 前置条件 | 说明 |
|---|---|---|
| `before` | `email.driver=outbox` | 邮件只写进本机 outbox（`.eml` + `outbox_emails`），未真正发出 |
| `after` | `email.driver=ses`、`email.status=ok/degraded` | 经 SES 发出；沙盒期为 degraded（detail 以“沙盒”开头） |

只适用于 auth=local（cognito 档的验证 / 重置密码邮件由 Cognito 发送，不经过 EmailPort）。邮件是对外副作用，不做运行时 A/B。

## send-matrix（必需）

```bash
npm run exp -- email --label before --scenario send-matrix --param to=you@example.com --upload
scripts/module enable email --param Email=you@example.com     # 到邮箱点击 AWS 的验证链接，脚本轮询到“已验证”才写 env
npm run exp -- email --label after  --scenario send-matrix --param to=you@example.com --upload
npm run exp:report -- email
```

地址：SES 邮箱模拟器 `success@`、`bounce@`、`complaint@simulator.amazonses.com`（沙盒中也能发，不损害发件信誉）与可选的你自己的已验证地址。
每个地址注册测试用户（已存在则跳过）并触发“找回密码”，再轮询 `/api/admin/outbox`（服务端证据）直到反馈回流：
success → `delivered`、bounce → `bounced`（用户 `email_status=bounced`）、complaint → `complained`。outbox 档全部是“写入 outbox，未真正发出”。

## sandbox（观察，after）

```bash
npm run exp -- email --label after --scenario sandbox --param to=<一个没有在 SES 验证过的地址>
aws sesv2 get-account --query "{production:ProductionAccessEnabled,quota:SendQuota}"
```

沙盒中发给未验证地址：服务端记录 `status=failed`、错误 `MessageRejected`，路径段 `email=ses:rejected`
（`EMAIL_SANDBOX_POLICY=outbox` 时改写进本机 outbox）。不要用 example.com 等保留域名——EmailPort 不会为它们调用 SES。

## register-latency（选做）

```bash
npm run exp -- email --label before --scenario register-latency
npm run exp -- email --label after  --scenario register-latency
```

注册 `count`（默认 10）个 `success+reg-<runId>-<n>@simulator.amazonses.com` 用户，比较注册接口延迟与 Server-Timing 的 `email` 段。
文档原写法是 k6 脚本 `register.k6.js`，本仓库的运行器不依赖 k6，以 Node 场景实现同样的请求序列。注册接口每 IP 10 分钟限 20 次。

## compare（选做）

```bash
npm run exp -- email --label after --scenario compare --param to=you@example.com     # 或 npx tsx experiments/email/compare.ts --param to=…
```

`POST /api/lab/email/compare {to}`：同一封邮件经 outbox 与 ses 驱动各发一次，并排显示耗时与结果。

## 认证结果（手工）

在邮箱客户端“显示原始邮件”：`DKIM-Signature` 与 `Authentication-Results`。邮箱身份由 SES 以自己的域签名（与发件域不对齐）；
域名身份 + Easy DKIM 才与发件域对齐，配好自定义 MAIL FROM 后 SPF 也对齐。
