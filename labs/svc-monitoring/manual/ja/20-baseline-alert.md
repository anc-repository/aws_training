---
step: baseline-alert
---

before を記録します。**合成の 5xx エンドポイント**（リクエストの半分が 503 を返す）に毎秒 5 リクエストを送り、ローカル評価器が `app-5xx-rate` を ALARM にするまで続けます。

```bash {runsOn=workstation}
npm run exp -- monitoring --label before --scenario time-to-alert --upload
```

::experiment{module=monitoring id=time-to-alert label=before}

:::expected
`biz.local_alarm` は 1、`biz.local_detect_sec` は数十秒程度です（評価間隔 30 秒、ウィンドウ 5 分）。管理者のサイト内メッセージと `/admin/outbox` にそれぞれアラームが 1 件ずつあります。
:::

:::why
**なぜ共有の error5xx 障害ではなく合成エンドポイントを使うのでしょうか？** error5xx はすべてのリクエストに作用し、ラボ用インスタンスのヘルスチェックが 30 秒ごとに行う `/api/health/live` も対象になります。
ヘルスチェックが失敗すると api が再起動し、障害はプロセスとともに消えてしまいます。合成エンドポイントはそこに送られたリクエストにしか影響しないため、ローカル評価器と CloudWatch は同じ 5xx を見ることになります。
:::

::checks
