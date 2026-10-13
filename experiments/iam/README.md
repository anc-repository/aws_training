# iam 实验（访问 AWS 的凭证）

设计：[docs/modules/02-identity-security.md#iam](../../docs/modules/02-identity-security.md) 第 5 节。业务功能与性能两档相同，差别全在安全属性上。
实验机上不调用 AWS API、不引入 `@aws-sdk/*`：身份由服务端的管理员接口给出，泄露面与 IMDS 实验在实例上用 shell 脚本执行。

| 标签 | 前置条件 |
|---|---|
| `before` | `iam.driver=none` |
| `keys` | `iam.driver=keys`（长期访问密钥，反面教材） |
| `after` | `iam.driver=role`（实例配置文件 + IMDSv2；whoami / long-run / revoke 另要求 `iam.status=ok/degraded`） |

## whoami（凭证来源对照）

```bash
npm run exp -- iam --label before --scenario whoami
npm run exp -- iam --label keys   --scenario whoami
npm run exp -- iam --label after  --scenario whoami
npm run exp:report -- iam --experiment whoami            # 缺省 pair = keys,after
```

记录 `credentialSource`（none / static-keys / instance-profile）、ARN、访问密钥前 4 位（AKIA / ASIA）、过期时间、`/api/lab/self-check` 报告的已加载
AWS SDK（none 档必须为 0）与 CRED-* 校验发现。身份来自 `GET /api/lab/iam/whoami`（iam 模块提供；未实现时只用 capabilities 的 iam 段）。

## leak-scan（在实例上）

```bash
sudo bash experiments/iam/leak-scan.sh                                    # 直接看
sudo -E npm run exp -- iam --label keys --scenario leak-scan              # 经运行器，结果写入 _results/
SCAN_ROOT=/mnt/snap sudo -E bash experiments/iam/leak-scan.sh             # 快照挂载后扫描（可选）
```

扫描 `/etc/cloudalbum`、数据卷（含同盘本地备份）、`/var/log`、`journalctl -u 'cloudalbum-*'`、各进程环境、`~/.aws`、shell 历史，按类别统计 AKIA / ASIA 命中数，
只输出计数与文件路径。keys 模式预期多处命中 AKIA；role 模式为 0。

## imds-ssrf（在实例上）

```bash
bash experiments/iam/imds-ssrf.sh
```

不带会话令牌的 GET 返回 401（IMDSv2 必需），PUT 取令牌后 GET 才返回 200 与角色名。注意：能在实例上执行命令的人仍能拿到临时凭证，最小权限依然必要。

## revoke

```bash
npm run exp -- iam --label keys  --scenario revoke
npm run exp -- iam --label after --scenario revoke --duration 20m
```

以 1 rps 请求 `GET /api/lab/aws-ping`（GetCallerIdentity 与 iam:GetRole 两列），第 60 秒运行器提示人工操作：

- keys：`aws iam update-access-key --user-name cloudalbum-<env>-demo-keys --access-key-id AKIA… --status Inactive`；
- role：控制台打开 `CloudAlbumAppRole` → Revoke sessions → Revoke active sessions；几分钟后在运维机运行
  `INSTANCE_ID=i-… TARGET=http://<EIP> CLOUDALBUM_ADMIN_TOKEN=… bash experiments/iam/refresh-role-creds.sh`（换新会话 + `POST /api/lab/iam/refresh`）。

观察两列各自的 `firstFailAtMs` / `recoveredAtMs`：role 模式 iam:GetRole 列开始显式 Deny，而 GetCallerIdentity 列照常成功（它不能用作权限探针）。
实验结束后删除 `AWSRevokeOlderSessions` 内联策略；keys 模式删除或重新激活该密钥。

## long-run

```bash
npm run exp -- iam --label after --scenario long-run --duration 6h
```

确认凭证刷新前后 `scenario.errors=0`。CloudTrail 对照（AssumedRole + ASIA vs IAMUser + AKIA）：
`aws cloudtrail lookup-events --lookup-attributes AttributeKey=Username,AttributeValue=<实例 ID 或演示用户名>`。
