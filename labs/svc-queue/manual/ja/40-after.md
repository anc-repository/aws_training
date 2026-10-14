---
step: after
---

同じ突発的なアップロードを行います。今回はランナーが 30 秒目に worker を `kill -9` し、その後 systemd が自動で再起動します。

```bash {runsOn=workstation}
npm run exp -- queue --label after --scenario upload-burst --upload
```

::experiment{module=queue id=upload-burst label=after}

:::expected
`biz.jobs_lost` は 0 です。強制終了の時点で処理中だったメッセージは削除されておらず、可視性タイムアウト後に再び現れて、再起動した worker が処理します。
キューが空になるまでの時間は before より長く、CPU グラフはスパイクから平らな形に変わります（ピーク平準化）。
:::

:::saa{domain=resilient confusable="可见性超时 vs 消息保留期"}
可視性タイムアウトは 1 つのジョブの最長処理時間より長くし、長いジョブは処理中に定期的に可視性を延長します（ハートビート）。メッセージの保持期間は、誰も処理しないメッセージをどれだけ残しておけるかを決めます。
:::

::checks
