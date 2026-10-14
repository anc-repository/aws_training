# experiments/shell-access：SSH 22 + 密钥对 vs Session Manager

对应 [05-ops-observability.md#shell-access](../../docs/modules/05-ops-observability.md#shell-access) 第 5 节。shell-access 不在请求路径上，
服务端证据来自控制面（以运维者 / 学员身份只读调用 AWS CLI v2）与应用的 capabilities（shell-access 感知器）。

| 实验 | 标签 | 运行 | 服务端证据 |
|---|---|---|---|
| `probe-port` | before / after | `npm run exp -- shell-access --label before --scenario probe-port --param target=private-ip --upload`，切换后 `--label after` | 安全组中覆盖 22 的入站规则数（`aws ec2 describe-security-group-rules`）；capabilities 的 shell-access 段 |
| `session-audit` | after | `npm run exp -- shell-access --label after --scenario session-audit --upload` | `DescribeSessions`、会话日志流、CloudTrail `StartSession`，按会话 ID 对齐 |
| `ssh-noise` | 手工 | 见下文 | `security/snapshot.json` 的 `sshd.failures24h`、fail2ban 封禁数 |
| `private-subnet` | 手工 | 见下文（需要 network） | `PingStatus` 与能否打开会话 |

工作台需要 AWS CLI v2 与 Session Manager plugin（平台工作台已安装）；运行器只调用只读 API：`ec2:DescribeInstances`、
`ec2:DescribeSecurityGroupRules`、`ssm:DescribeSessions`、`logs:DescribeLogStreams`、`cloudtrail:LookupEvents`。

## 端口探测（probe-port）

- `target=public`（缺省）探测 `EXP_TARGET` 的主机；`target=private-ip` 探测实验机的私网地址（平台模式：SSH 基线只对工作台私网 /32
  开放，经公网地址探测在 before 时就是超时）；也可以 `--param host=<地址>`。
- 每个端口尝试 5 次、超时 3 秒：任一次连上为 `open`，全部超时为 `filtered`（安全组丢弃），被拒绝为 `closed`（可达但没有进程监听）。
- 手工对照：`nc -vz -w 3 <地址> 22`。

## 会话与端口转发（手工，配合 session-audit）

```bash
aws ssm start-session --target <实例 ID>                         # 以 cloudalbum-ops 打开 shell（会话首选项 runAsDefaultUser）
id                                                               # uid=…(cloudalbum-ops)
sudo systemctl status cloudalbum-api --no-pager                  # 允许（受限 sudoers：逐条列出的完整命令）
sudo journalctl -u cloudalbum-api -n 50 --no-pager               # 允许
sudo -n cat /etc/cloudalbum/secrets.env; echo rc=$?              # 拒绝：rc=1
sudo -n journalctl -u cloudalbum-api --vacuum-time=1s; echo rc=$? # 拒绝：rc=1（参数不在白名单，不能以 root 删改系统日志）
sudo -n journalctl -u cloudalbum-api -u sshd --no-pager; echo rc=$? # 拒绝：rc=1（不能借 -u 读其他单元）
exit

aws ssm start-session --target <实例 ID> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3000"],"localPortNumber":["13000"]}'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:13000/api/health/ready   # 另开一个终端：200
```

然后运行 `session-audit`：CloudTrail 事件有分钟级延迟，脚本最多轮询 15 分钟（`--param waitMin`）。端口转发会话不记录内容，
所以只统计 shell 会话的日志流；平台终端会话（文档 `ATL-SessionShell*`、ID 形如 `atl-<sid>-term-…`）不计入。

## 爆破噪声（ssh-noise，手工，不在卡片中）

只能在自己的实验实例上做，做完立即改回：

1. scripts/module 不提供“对全网开放 22”的操作（`base deploy` 拒绝宽于 /32 的 `--ssh-cidr`，00 的 6.4）：在 CloudFormation 控制台更新栈
   `cloudalbum-<env>-ec2`（使用当前模板），只把参数 `SshIngressCidr` 改为 `0.0.0.0/0`，并给自己设一个改回的提醒。
2. 24 小时内每小时记录一次实验机上 `jq .sshd /var/lib/cloudalbum/security/snapshot.json` 的 `failures24h` 与
   `jq '.fail2ban.jails' …` 的封禁数。
3. 改回 `/32`，或启用 shell-access 关闭 22 端口后再观察 24 小时：失败次数归零。

## 私有子网（private-subnet，手工，需要 network）

在 app 子网启动一台没有公网 IP、安全组没有入站规则、挂同一实例配置文件的临时实例：有 NAT 或 `ssm`、`ssmmessages`
（建议保留 `ec2messages`）Interface Endpoint 时可以 `aws ssm start-session`；删掉 `ssmmessages` 端点后实例仍显示 Online，
但打不开会话。做完删除临时实例与端点（端点按小时计费）。组合场景 `sc-private-network` 中进行。
