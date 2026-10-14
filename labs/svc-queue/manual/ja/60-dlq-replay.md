---
step: dlq-replay
---

デッドレターキューのメッセージは自動では処理されません。handler を直した後で、元のキューに「再処理（リドライブ）」できます。ここでは handler を直していないので、メッセージが再びデッドレターキューに戻るのを確認します。

```bash {runsOn=workstation}
aws sqs start-message-move-task --source-arn "{{ var.dlqArn }}"
aws sqs list-message-move-tasks --source-arn "{{ var.dlqArn }}" --query "Results[].[Status,ApproximateNumberOfMessagesMoved]" --output table
```

:::expected
移動タスクが完了すると、デッドレターキューのメッセージ数はいったん 0 になります。数分後、不正なメッセージは再び 3 回受信に失敗し、デッドレターキューに戻ってきます。
:::

:::saa{domain=resilient}
標準キューのメッセージはデッドレターキューに入った後も、有効期限は最初にキューに入った時点から数えられます。そのためデッドレターキューの保持期間は元のキューより長くします。
`RedriveAllowPolicy` で、どの元のキューがデッドレターキューを送り先にできるかを制限できます。
:::

::checks
