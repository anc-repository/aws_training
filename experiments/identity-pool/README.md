# identity-pool 实验（应用自签前缀令牌 vs Cognito Identity Pool 临时凭证）

对应 [02#identity-pool 第 5 节](../../docs/modules/02-identity-security.md#identity-pool)。两边都是 F14（多文件、分片、续传、按前缀授权），
区别只在“授权由谁执行”：none 驱动由应用代码逐片校验令牌与键前缀；cognito 驱动由 S3 按 IAM 策略变量 `${cognito-identity.amazonaws.com:sub}` 执行。

| 标签 | 前置条件（capabilities） |
|---|---|
| `before` | `identity-pool.driver=none`（前缀令牌；起始状态通常是 storage=s3 + auth=cognito） |
| `after` | `identity-pool.driver=cognito`，状态 ok / degraded（HTTP 站点上 DEP-030 使其为 degraded） |

## 测试用户

越权实验需要两个用户 A、B（另外两个实验用第一个）。按优先级读取：

1. `--param users=<文件>`：JSON（平台种子 `cognito-test-users` 的格式 `[{ "email": "…", "password": "…" }]`）或 CSV（每行 `email,password`）；
2. 环境变量 `CLOUDALBUM_TEST_USERS_PARAM`（平台工作台）：脚本用 AWS CLI 读取这个 SecureString；
3. 环境变量 `EXP_USERS_FILE`。

登录方式跟随 auth 驱动：local → `POST /api/auth/login`；cognito → `USER_SRP_AUTH`（[cognito-srp.ts](cognito-srp.ts)，与浏览器里的 Amplify 相同；
SPA 客户端只允许 SRP）。测试用户不能开启 MFA。密码只在进程内存中使用，不写进结果。

用户的请求不带实验头（服务端只接受管理员的 `X-Experiment-*`），所以卡片把这些实验登记为 `validity: functional`，由服务端的
`path-seen` 检查佐证；场景另外以管理员身份读取服务端证据（见各场景）。

## 场景

```bash
cd experiments
npm run exp -- identity-pool --label before --scenario cross-prefix --param users=/tmp/test-users.json
npm run exp -- identity-pool --label before --scenario upload-bench --param users=/tmp/test-users.json --param files=20
npm run exp -- identity-pool --label before --scenario resume       --param users=/tmp/test-users.json
scripts/module enable identity-pool                                   # （仓库根目录）
npm run exp -- identity-pool --label after  --scenario cross-prefix --param users=/tmp/test-users.json --upload
npm run exp -- identity-pool --label after  --scenario upload-bench --param users=/tmp/test-users.json --param files=20 --upload
npm run exp -- identity-pool --label after  --scenario resume       --param users=/tmp/test-users.json --upload
npm run exp:report -- identity-pool --experiment upload-bench
```

| 场景 | 做什么 | 服务端证据 |
|---|---|---|
| `cross-prefix` | A 写自己的前缀（允许）、写 B 的前缀、列出（B 的分片 / 整个桶）、删除 B 的对象（拒绝）；记录每次由谁拒绝（`deniedBy: application / s3`） | sts：`GET /api/lab/identity-pool/staging-object` 确认 A 的对象存在、写到 B 前缀的对象不存在、B 的对象没被删；token：B 的照片在服务端仍是 `UPLOADING` |
| `upload-bench` | 同一用户上传 `files` 个 `fileMb` 的 JPEG；每个文件对 EC2 / S3 的请求数、总耗时、单文件 p50 / p95；`host.net_rx_bytes` 是 EC2 入站字节 | 每张照片在服务端的状态；sts 抽查暂存对象在 complete 之后已删除（服务端 CopyObject + DeleteObject） |
| `resume` | 在第 `failAtPart` 片之前中断（`pauseSec` 可留出真的断网时间），续传只补缺失的分片 | 续传前服务端（`/api/storage/upload/parts`）或 S3（`ListParts`）报告的已收分片；complete 之后照片的服务端状态 |
| `policy-sim` | 手工：IAM Policy Simulator（下文） | — |

常用参数：`--param mode=token|sts`（缺省按驱动）、`--param s3Endpoint=http://127.0.0.1:4566`（路径式 S3 端点，LocalStack / 测试替身）。

## policy-sim（手工）

1. IAM 控制台 → 角色 → `cloudalbum-<env>-identity-pool-uploader`（模块文档中的 “CloudAlbumUploaderRole”）→ **信任关系**：确认同时有
   `cognito-identity.amazonaws.com:aud`（等于本身份池 ID）与 `cognito-identity.amazonaws.com:amr`（`authenticated`）两个条件。
2. 打开 IAM Policy Simulator，选择这个角色；服务选 S3：
   - `PutObject`，资源 `arn:aws:s3:::cloudalbum-<env>-upload-staging-<账号>/private/<你的 identityId>/x.jpg`，在“全局设置 / 上下文键”中把
     `cognito-identity.amazonaws.com:sub` 设为同一个 identityId → **allowed**；
   - 同一请求，资源换成别人的 identityId → **implicitDeny**；
   - `DeleteObject`（任何键）→ **implicitDeny**（Uploader 角色没有删除权限）；
   - `ListBucket` 不带 `s3:prefix` → **implicitDeny**；带 `s3:prefix = private/<你的 identityId>/` → **allowed**。
3. 记下结果（卡片的 MAN 检查）。你的 identityId 可以在 `/lab` 的 identity-pool 卡片或 `GET /api/lab/identity-pool/whoami`（管理员）里看到。

## 预期

- 越权：两边都拒绝；before 由应用返回 403 `UPLOAD_PREFIX_DENIED`，after 由 S3 返回 `AccessDenied`。
- 每个文件对后端的请求数：before 随分片数线性增长（建档 + 每片一次 + complete），after 与分片数无关（建档 + complete）。
- EC2 入站流量：storage=local 的 token 模式与上传字节同一量级；storage=s3 的 token 模式与 sts 模式下只有元数据。
- after 的代价：服务端控制力变弱（IAM 管不了大小与类型，靠 complete 校验与暂存桶 1 天过期兜底），每张照片多一次 CopyObject 与 DeleteObject。
