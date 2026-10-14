---
step: baseline
---

before を記録します。読み書き混在の負荷試験を、同時実行数 10 と 50 の 2 段階で順に実行します。リクエストの 30% は書き込み（コメントの投稿、非公開アルバムの作成。終了後に削除）で、残りはタイムラインの読み取りです。

```bash {runsOn=workstation}
npm run exp -- database --label before --scenario mixed-rw --vus 10,50 --upload
```

::experiment{module=database id=mixed-rw label=before}

:::expected
同時実行数 10 ではタイムラインの p95 はとても低くなります。同時実行数 50 では書き込みが順番待ちになり、`host.event_loop_delay.p99` にスパイクが出ます。
:::

::checks
