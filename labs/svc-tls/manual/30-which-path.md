---
step: which-path
---

先看计划：`scripts/module` 会用你的身份调用 `acm:ListAcmeEndpoints` 探测 ACME 端点（preflight `acme-endpoint`，只读）。
可用时 `TLS_ACME=on`；命令不存在、区域不支持、被权限或 SCP 拒绝都算不可用，回退为 `TLS_ACME=off`。

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }} --dry-run 2>&1 | grep -E 'preflight|TLS_ACME|DEP-005'
```

:::expected
有一行 `preflight acme-endpoint：…`，给出 `TLS_ACME=on` 或回退的原因；回退时另有 DEP-005 ③ 的依赖说明（dns 或外部 DNS + cdn 或 load-balancer）。
`--dry-run` 不调用 AWS，所以它按 `TLS_ACME=on` 计划；去掉 `--dry-run` 的真实执行才会探测。
:::

:::tip
想练习考试形态时加 `--no-acme`：直接写 `TLS_ACME=off`，不探测。平台已经按账号预检选好了本次的变体（`{{ session.variant }}`）。
:::

::checks
