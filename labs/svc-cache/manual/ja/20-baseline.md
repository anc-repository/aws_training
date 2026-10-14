---
step: baseline
---

before を記録します。20 人の同時ユーザーが 120 秒間タイムラインを読み続けます（ランナーは専用の実験用ユーザーを使うので、あなたのアルバムには影響しません）。

```bash {runsOn=workstation}
npm run exp -- cache --label before --scenario feed-read --vus 20 --duration 120s --upload
```

::experiment{module=cache id=feed-read label=before}

:::expected
リクエストあたりのデータベース呼び出し回数が 0 より大きく、cache セグメントはすべて `none`、エラー数は 0 です。
:::

::checks
