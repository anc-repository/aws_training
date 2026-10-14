# 简易实机验证记录（2026-10-14）

目的：用真实 AWS 账号，最小范围地跑通一次：CloudAlbum L0 部署 → 冒烟测试 → 启用 iam + storage(S3) → 启用 cdn(CloudFront) → 全量回收。
这不是 07 验证计划的完整执行。阶段 1、2 的 IAM 与 SSM PoC，以及平台（ATL）的安装与卡片走查，都没有在这一轮进行。

## 环境

| 项目 | 值 |
|---|---|
| 区域 | ap-northeast-1（全量回收时同时核对了 us-east-1） |
| 身份 | 账号根用户的访问密钥。用户明确选择这样做，验证完成后由用户删除这把密钥 |
| 账号 | Organizations 的管理账号，组织内只有这一个账号。07 的前提 A1 要求不使用管理账号，用户确认后仍在这个账号中执行 |
| 实例 | t4g.small（arm64），默认 VPC 公有子网，发布包 `cloudalbum-app-arm64`（v0.1.0-dev，见下文“修复”） |
| 本机 | Node 22.14、AWS CLI 2.34.45、OpenSSH 9.9；CLI 配置文件的 `output` 写成了大写 `JSON`，执行时用 `AWS_DEFAULT_OUTPUT=json` 覆盖 |

## 结果

| 步骤 | 命令 | 结果 |
|---|---|---|
| 工具链栈 | `scripts/module bootstrap` | 成功，41 秒 |
| L0 部署（第 1～3 次） | `scripts/module base deploy` | 失败：引导脚本发出 FAILURE 信号（原因见“发现 1”） |
| L0 部署（修复后） | `scripts/module base deploy` | `CREATE_COMPLETE`，2 分 26 秒 |
| L0 冒烟（经 EIP） | `node scripts/smoke/remote.mjs --profile l0` | **20/20 通过**：注册 → 验证 → 登录 → 上传 → 缩略图 → 时间线 → 点赞评论 → 通知 → 分享 → 日报 → capabilities → 路径头 → 管理员旁路 → 审计 |
| 启用 iam(role) + storage(S3) | `scripts/module enable storage --with-deps --no-migrate` | 成功，5 分 3 秒 |
| S3 档冒烟 | `node scripts/smoke/remote.mjs --profile s3` | 第 1 次 19/20（发现 2），第 2 次 **20/20**；浏览器直传 S3 预签名 URL |
| 启用 cdn(CloudFront) | `scripts/module enable cdn` | 成功，4 分 27 秒，分配 `Deployed`；警告 DEP-028（`MediaOrigin=ec2` 与 `storage=s3` 组合，符合设计） |
| CloudFront 缓存 | `curl` 静态资源 3 次 | `Miss` → `Hit` → `Hit`（`Age` 递增，POP NRT57）；`/api/*` 不缓存，路径头为 `entry=cloudfront>nginx` |
| 经 CloudFront 的全流程 | `remote.mjs --profile s3 --entry 'cloudfront>nginx'` | 19/20，唯一失败与发现 2 相同（重启后 1～2 分钟内） |
| 全量回收 | `scripts/module teardown`，再手动删除 Retain 资源 | 栈全部 `DELETE_COMPLETE`；删除 3 个 S3 桶（含全部版本）、数据卷、密钥对；两个区域零残留 |

首字节时间：从日本测试，EC2 直连与 CloudFront 的中位数分别约为 23 ms 与 32 ms，两者接近。实例和用户都在东京，所以这是预期结果；地域差异要从远端区域测量（svc-cdn 卡片的实验设计）。

## 发现与修复

1. **新建的 EBS 数据卷读出来不是全零（阻断，已修复）**
   - 现象：`l0-bootstrap.sh` 的 E5 保护逻辑是“没有文件系统且前 1 MiB 全零才格式化”。实测一块由本栈新建、没有快照、实例也从未写过的 gp3 加密卷，从 4096 字节偏移起就能读到非零数据，于是脚本拒绝格式化，CreationPolicy 收到 FAILURE。
   - 修复：模板把卷的来源以 `DATA_VOLUME_ORIGIN=new|existing` 写入 `params.env`；脚本只格式化“没有文件系统且由本栈新建”的卷，接管的卷没有文件系统时照旧拒绝。
   - 相关文件：`infra/modules/ec2.yaml`、`infra/userdata/l0-bootstrap.sh`。
   - 修复后一次部署成功。
2. **api 重启后 1～2 分钟内，ec2 探针报 IMDS 不可达（已修复）**
   - 原因：IMDS 客户端超时 300 ms；进程刚启动时首个应答超时，又被 60 秒负缓存放大，`/api/capabilities` 里 ec2 依次显示 `error` → `degraded` → `ok`，约 3 分钟。
   - 修复：超时改为 1 秒，判定不可达前重试 2 次（间隔 100、300 ms），全部失败才进入负缓存。
   - 相关文件：`backend/src/modules/detectors/ec2.ts`，并补了测试。
3. **独立模式的 `base deploy --disable-rollback` 不生效（已修复）**
   - 原因：选项只在平台模式下传给 `deployStack`。
   - 修复：独立模式同样传入；同时把 `AppArchiveUrl` 标为机密参数，在输出中打码。
   - 相关文件：`scripts/module-cli/src/bootstrap.ts`。
4. **新增实机冒烟测试脚本**
   - `scripts/smoke/remote.mjs`：对已部署的实例跑 `flow.mjs` 的同一套流程；`admin:create` 经 SSH 在实例上执行。
   - `flow.mjs` 的 `entry` 期望值改为由 profile 决定（本机直连为 `direct`，EC2 上为 `nginx`，经 CloudFront 为 `cloudfront>nginx`）。

## 未覆盖、留给后续

- 07 阶段 1、2 的 IAM、STS、SSM PoC。根用户不能调用 `sts:AssumeRole`，需要在成员账号中、用 IAM 用户执行。
- 平台（ATL）的安装、卡片走查、倒计时回收、报告与证书。
- 其余 5 个 MVP 模块（auth、queue、image-processing、cache、database）的实机启停。
- `storage` 的数据迁移：迁移脚本仍是桩，这一轮用的是 `--no-migrate`。
- 发布包需要用修复后的 `l0-bootstrap.sh` 重新构建。这一轮是在原发布包中只替换了这个文件。
