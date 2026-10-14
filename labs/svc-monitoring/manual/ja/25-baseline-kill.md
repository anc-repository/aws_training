---
step: baseline-kill
---

before を記録します。障害スクリプトが SSM 経由でラボ用インスタンスの api と worker を停止し、5 分後に systemd のタイマーで自動的に起動し直します。ランナーは
`/api/health/live` をポーリングして停止期間を区切り、復旧後に `alert_events` を読みます。停止中にローカル評価器がアラームを出したかどうかを確認します。

```bash {runsOn=workstation}
npm run exp -- monitoring --label before --scenario kill-test --param phase=service --fault-via ssm --instance-id {{ target.instanceId }} --upload
```

::experiment{module=monitoring id=kill-test label=before}

:::expected
`biz.local_alerts_during_outage` は 0 です。worker が api と一緒に止まったので、評価器は沈黙しています。停止中はサイト内メッセージもメールもありません。
:::

:::warning
停止している 5 分間はアプリのプレビューが開けません。これは想定どおりです。復旧はラボ用インスタンス上の systemd の一時タイマーが担うので、コマンドを中断してもサービスは時間どおりに起動します。
:::

::checks
