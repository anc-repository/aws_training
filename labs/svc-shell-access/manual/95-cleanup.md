---
section: cleanup
---

- 自动回收先执行 `scripts/module disable shell-access` 的等价流程：按备份**还原** `SSM-SessionManagerRunShell`、删除 `cloudalbum-ops`
  与 sudoers 片段、分离策略、删除栈；会话日志组是 `DeletionPolicy: Retain`，由回收器删除。
- `SSM-SessionManagerRunShell` 是账号 × 区域级单例，影响同区域所有使用默认文档的会话：不要在控制台的 Session Manager“首选项”页手工修改它。
- 如果为了排障临时在安全组加过 22 规则，结束前删除（最终复核会检查）。
- 端口转发会话在工作台按 Ctrl+C 结束；shell 会话空闲 20 分钟会自动断开（会话首选项 `idleSessionTimeout`）。
- 独立使用（非平台）时，禁用要显式重新开放 22：`scripts/module disable shell-access --reopen-ssh`（运维 IP 变了再加 `--param SshIngressCidr=<ip>/32`）。
