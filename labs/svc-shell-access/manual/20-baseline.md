---
step: baseline
---

记录 before：从工作台探测实验机**私网地址**的 22 与 443 端口（各 5 次，超时 3 秒），并读取安全组的 22 端口规则作为服务端证据。

```bash {runsOn=workstation}
npm run exp -- shell-access --label before --scenario probe-port --param target=private-ip --upload
```

::experiment{module=shell-access id=probe-port label=before}

然后用 SSH 登录一次，看看 SSH 能留下哪些审计信息：

```bash {runsOn=workstation}
ssh lab 'id; sudo journalctl -u sshd -n 5 --no-pager -o cat'
```

:::expected
报告中 `port22.result` 是 `open`、`sgRules22` 为 1；journal 里只有 `Accepted publickey for ec2-user from <工作台 IP> … SHA256:…`：
知道“哪把钥匙从哪个 IP 登录”，不知道登录后做了什么。
:::

:::tip
平台模式下 22 只对工作台私网地址开放，经公网地址探测在 before 时就是超时，所以这里用 `--param target=private-ip`
（运行器用 `aws ec2 describe-instances` 查实验机的私网地址）。
:::

::checks
