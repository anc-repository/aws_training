---
step: poison
---

ワークベンチの ID を使って、worker が解析できない「不正なメッセージ」をジョブキューに直接送ります。

```bash {runsOn=workstation}
aws sqs send-message --queue-url "{{ var.queueUrl }}" --message-body 'not-a-job-envelope'
```

worker はこれを受け取っても削除しません（捨ててよいか判断できないため）。受信回数に応じて間隔を空けて再試行し、3 回受信しても失敗すると SQS がデッドレターキューに移します。30 秒ごとに 2 つのキューを確認します。

```bash {runsOn=workstation}
for i in $(seq 1 20); do
  aws sqs get-queue-attributes --queue-url "{{ var.dlqUrl }}" --attribute-names ApproximateNumberOfMessages --query Attributes --output text
  sleep 30
done
```

:::wait{typical=8 max=20}
受信のたびに可視性タイムアウト（と受信回数に応じたバックオフ）を待ってから再び見えるようになるため、デッドレターキューに入るまで数分かかります。
その間に `/admin/jobs` を開くと、このメッセージの受信回数が増えていく様子が見えます。
:::

:::expected
デッドレターキューの利用可能なメッセージ数が 1 になります。元のキューの正常なジョブは影響を受けず、処理され続けます。
:::

::checks
