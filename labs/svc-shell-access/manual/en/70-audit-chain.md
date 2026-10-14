---
step: audit-chain
---

Line up three pieces of evidence by session ID: session history (`ssm describe-sessions`, who and when), the session log stream (what was run) and CloudTrail `StartSession` (the IAM identity).
The script makes read-only AWS CLI calls with your learner identity and excludes platform terminal sessions; CloudTrail events lag, so it polls for up to 15 minutes.

```bash {runsOn=workstation}
npm run exp -- shell-access --label after --scenario session-audit --upload
```

::experiment{module=shell-access id=session-audit label=after}

::console-link[Open the session log group]{link=logs.group logGroupEncoded="{{ var.sessionLogGroup | url }}"}

:::expected
`aligned` is at least 1: the shell session you opened in step 4 has both a session log stream and a StartSession event; the port-forwarding session only appears in session history and CloudTrail.
:::

:::saa{domain=secure confusable="CloudTrail vs 会话日志"}
CloudTrail records who opened a session when (`StartSession` and `TerminateSession` are both management events); the commands run within a session never reach CloudTrail and are only in the session logs.
:::

::checks
