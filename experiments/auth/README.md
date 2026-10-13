# auth 实验（有 / 无 Cognito User Pool）

设计：[docs/modules/02-identity-security.md#auth](../../docs/modules/02-identity-security.md) 第 5 节。

| 标签 | 前置条件 |
|---|---|
| `before` | `auth.driver=local`（argon2id 哈希 + ES256 JWT） |
| `after` | `auth.driver=cognito`（login-storm 另要求 `auth.status=ok/degraded`） |

测试账号：`scripts/admin seed-users` 生成，写成 CSV（每行 `email,password`），用 `--param users=<csv>` 或 `EXP_USERS_FILE` 传入。
**不要**用运行器自己的管理员账号做 brute-force / revoke（会被锁定或令牌全部失效，脚本会拒绝）。

cognito 档：总纲规定浏览器经 Amplify 直连 User Pool（EC2 不经手密码）。实验脚本用 User Pool 的公开接口 `InitiateAuth`（USER_PASSWORD_AUTH，
不需要 AWS 凭证）模拟浏览器登录，因此实验用的 App Client 需要允许 `ALLOW_USER_PASSWORD_AUTH`；只允许 SRP 时请在浏览器登录后
把 access token 填进 `CLOUDALBUM_ADMIN_TOKEN`，login-storm / revoke 不可用。

## login-storm

```bash
npm run exp -- auth --label before --scenario login-storm --param users=experiments/auth/users.csv --vus 10 --duration 60s
npm run exp -- auth --label after  --scenario login-storm --param users=experiments/auth/users.csv --vus 10 --duration 60s
npm run exp:report -- auth --experiment login-storm
```

观察：`POST /api/auth/login`（或 `POST cognito:InitiateAuth`）的 p50 / p95、`host.cpu.p95`（local 档 argon2 消耗 EC2 CPU）、登录后 `GET /api/me`
的 Server-Timing `auth` 段（cognito 首次需要拉取 JWKS）、`scenario.rateLimited`（429）与 `locked`（423）。CPU 积分余额看 CloudWatch（monitoring 启用时）。
登录请求不带管理员令牌，因此不带实验头，只出现在客户端统计里。双栈对比（`AUTH_DUAL_STACK=on`）时 local 与 cognito 各跑一次。

## token-claims

```bash
npm run exp -- auth --label before --scenario token-claims
npm run exp -- auth --label after  --scenario token-claims --param user=alice@example.test:<密码>
```

解码 access token（不验签）：local 为 `alg=ES256`、`iss=https://<host>`；cognito 为 `alg=RS256`、`iss=https://cognito-idp…`，带 `token_use`、
`client_id`、`cognito:groups`。同时取 JWKS 统计密钥数与算法。只输出声明名称与非敏感值，不输出令牌本身。

## feature-matrix / cloc

```bash
npm run exp -- auth --label before --scenario feature-matrix
npm run exp -- auth --label before --scenario cloc          # 离线：统计仓库中本地实现与 Cognito 适配器的代码行
```

## brute-force

```bash
npm run exp -- auth --label before --scenario brute-force --param email=victim@example.test --param attempts=30
```

记录响应码序列（`scenario.sequence`，例如 `401×5, 423×25`）与首次被拒绝的次序。cognito 档为 `400:NotAuthorizedException` 后转为“Password attempts exceeded”。

## revoke

```bash
npm run exp -- auth --label before --scenario revoke --param user=bob@example.test:<密码>
npm run exp -- auth --label after  --scenario revoke --param user=bob@example.test:<密码> --duration 16m
```

登录 → 登出 → 每 `intervalSec` 用旧 access token 请求 `/api/me`。local：立即 401（`tv` 检查）；cognito：本地验签的 access token 在过期前仍然有效
（`scenario.stillValidMs` 接近令牌寿命）。

## cross-instance

```bash
npm run exp -- auth --label before --scenario cross-instance --target https://<ALB 或 CDN 域名> --param n=200
```

按路径头 `inst=` 段统计各实例的成功率。local 档需要共享签名密钥与共享数据库（ASG-007、ASG-002/003），cognito 无状态。
