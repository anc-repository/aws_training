---
step: session
---

用 Session Manager 登录实验机（默认文档，不带 `--document-name`），验证会话以 `cloudalbum-ops` 打开、sudo 受限：

```bash {runsOn=workstation}
aws ssm start-session --target {{ target.instanceId }}
```

在打开的会话里执行：

```bash {runsOn=lab}
id
sudo systemctl status cloudalbum-api --no-pager | head -3
printf '{"user":"%s","secretsRc":%d}\n' "$(id -un)" "$(sudo -n cat /etc/cloudalbum/secrets.env >/dev/null 2>&1; echo $?)"
exit
```

:::expected
`id` 显示 `cloudalbum-ops`；`systemctl status` 允许；读取 `secrets.env` 被拒绝（`secretsRc` 非 0）。把最后一行 JSON 粘贴到检查里。
:::

:::why
默认的 `ssm-user` 与 AL2023 的 `ec2-user` 都有免密 sudo，把 runAs 换成 ec2-user 并不能降权。本模块的 hostSetup 创建专用用户
`cloudalbum-ops`，sudoers 只允许 `systemctl status|restart cloudalbum-*`、`journalctl -u cloudalbum-*`、`nginx -t` 与 `systemctl reload nginx`。
注意：Run Command（`scripts/module` 的投递通道）总是以 root 执行，不受 runAs 影响。
:::

:::wait{typical=5 max=20}
CloudTrail 的 StartSession 事件有几分钟到十几分钟的延迟；可以先做下一步的端口转发。
:::

::checks
