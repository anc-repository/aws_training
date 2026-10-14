---
step: which-path
---

まず計画を確認します。`scripts/module` はあなたの ID で `acm:ListAcmeEndpoints` を呼び出して ACME エンドポイントを調べます（preflight `acme-endpoint`、読み取り専用）。
使えるなら `TLS_ACME=on` です。コマンドが存在しない、リージョンが対応していない、権限や SCP で拒否された場合はすべて使えないものとみなし、`TLS_ACME=off` にフォールバックします。

```bash {runsOn=workstation}
scripts/module enable tls --domain {{ learner.inputs.domain }} --dry-run 2>&1 | grep -E 'preflight|TLS_ACME|DEP-005'
```

:::expected
`preflight acme-endpoint：…` の行があり、`TLS_ACME=on` またはフォールバックの理由が示されます。フォールバックの場合は、DEP-005 ③ の依存（dns または外部 DNS + cdn または load-balancer）の説明も表示されます。
`--dry-run` は AWS を呼び出さないので `TLS_ACME=on` として計画します。実際に調べるのは `--dry-run` を外して本当に実行したときだけです。
:::

:::tip
試験の形を練習したいときは `--no-acme` を付けます。調べずに直接 `TLS_ACME=off` を書き込みます。プラットフォームは、アカウントの事前チェックで今回のバリアント（`{{ session.variant }}`）をすでに選んでいます。
:::

::checks
