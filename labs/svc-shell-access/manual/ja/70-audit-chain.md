---
step: audit-chain
---

3 つの証拠をセッション ID で照合します。セッション履歴（`ssm describe-sessions`、誰が、いつ）、セッションのログストリーム（何を実行したか）、CloudTrail の `StartSession`（IAM ID）です。
スクリプトは受講者の ID で AWS CLI を読み取り専用で呼び出し、プラットフォームのターミナルのセッションを除外します。CloudTrail のイベントには遅延があるため、最大 15 分間ポーリングします。

```bash {runsOn=workstation}
npm run exp -- shell-access --label after --scenario session-audit --upload
```

::experiment{module=shell-access id=session-audit label=after}

::console-link[セッションログのロググループを開く]{link=logs.group logGroupEncoded="{{ var.sessionLogGroup | url }}"}

:::expected
`aligned` は少なくとも 1 です。ステップ 4 で開いたシェルセッションには、セッションのログストリームと StartSession イベントの両方があります。ポートフォワーディングのセッションは、セッション履歴と CloudTrail にだけ現れます。
:::

:::saa{domain=secure confusable="CloudTrail vs 会话日志"}
CloudTrail は「誰がいつセッションを開いたか」を記録します（`StartSession`、`TerminateSession` はどちらも管理イベントです）。セッション内で実行したコマンドは CloudTrail には入らず、セッションログにしかありません。
:::

::checks
