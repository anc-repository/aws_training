---
step: audit-chain
---

把三路证据按会话 ID 对齐：会话历史（`ssm describe-sessions`，谁、何时）、会话日志流（执行了什么）、CloudTrail `StartSession`（IAM 身份）。
脚本以你的学员身份只读调用 AWS CLI，排除平台终端会话；CloudTrail 事件有延迟，最多轮询 15 分钟。

```bash {runsOn=workstation}
npm run exp -- shell-access --label after --scenario session-audit --upload
```

::experiment{module=shell-access id=session-audit label=after}

::console-link[打开会话日志组]{link=logs.group logGroupEncoded="{{ var.sessionLogGroup | url }}"}

:::expected
`aligned` 至少为 1：你在第 4 步打开的 shell 会话同时有会话日志流与 StartSession 事件；端口转发会话只出现在会话历史与 CloudTrail 中。
:::

:::saa{domain=secure confusable="CloudTrail vs 会话日志"}
CloudTrail 记录“谁在何时开了会话”（`StartSession`、`TerminateSession` 都是管理事件）；会话里执行的命令不进 CloudTrail，只在会话日志里。
:::

::checks
