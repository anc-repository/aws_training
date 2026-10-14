---
step: ingest
---

after を記録します。20 件のリクエストを送り、その後 2 秒ごとに CloudWatch を検索して、すべてが現れるまで待ちます。

```bash {runsOn=workstation}
npm run exp -- logging --label after --scenario ingest-lag --upload
```

::experiment{module=logging id=ingest-lag label=after}

:::expected
`local.foundImmediately` はリクエスト数と等しくなります（ローカルでは即座に見えます）。`ingestLagP50Ms` は CloudWatch 側の取り込みの遅延（`ingestionTime − timestamp`）で、
数秒から十数秒です。`missing` は 0 です。
:::

:::why
取り込みの遅延は 2 つの部分からなります。送信機のバッチ間隔（`LOG_CW_FLUSH_MS`、デフォルト 2 秒。agent 方式では約 5 秒）と、CloudWatch の取り込みです。イベント時刻には Nginx の行の
`ts`（秒単位の精度）を使うため、個々の値には 1 秒未満の誤差があります。
:::

::checks
