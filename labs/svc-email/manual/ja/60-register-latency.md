---
step: register-latency
---

auth=local の登録は、リクエストの中で EmailPort を直接呼び出します。outbox 階層ではファイルを 1 回書くだけ（ミリ秒単位）ですが、SES 階層では HTTPS API を 1 回呼び出します（数十から百数十ミリ秒程度）。
ランナーは `success+reg-<runId>-<n>@simulator.amazonses.com` のユーザーを 10 人登録し、登録 API のレイテンシーと Server-Timing の `email` セグメントを記録します。

```bash {runsOn=workstation}
npm run exp -- email --label after --scenario register-latency --upload
npm run exp:report -- email --experiment register-latency
```

::experiment{module=email id=register-latency label=after}

:::expected
after の `emailMsP50` は、ステップ 1 でついでに実行した before（実行していれば）よりはっきり高く、登録 API の p95 もそれに応じて遅くなります。
送信をキューに入れれば（`QUEUE_DRIVER=sqs` の `email.send` タスク）、ユーザーはこの遅延を感じなくなります。
:::

::checks
