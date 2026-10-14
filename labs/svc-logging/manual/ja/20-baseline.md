---
step: baseline
---

before を記録します。ランナーはまず `error5xx` 障害を有効にし（約 20% のリクエストが 503 を返し、120 秒後に自動で解除されます）、一定の負荷で `/api/lab/now` にリクエストしてから、
**ローカル側**で 2 つのクエリ、「ルートごとの 5xx の集計」と「リクエスト ID での検索」を実行します。

```bash {runsOn=workstation}
npm run exp -- logging --label before --scenario query-compare --upload
```

::experiment{module=logging id=query-compare label=before}

:::expected
レポートの `local.errors` はクライアントが受け取った 503 の数と等しく（`agreeLocal`）、ローカルの走査にかかった時間とスキャンしたバイト数が示されます。`cloudwatch` 側は利用不可と表示されます。
:::

:::why
ローカルのクエリはインスタンス上で現在のファイルと `.1` を末尾から走査します。データが少なければ速いのですが、所要時間はファイルサイズに比例して増え、しかもこのマシンの直近 2 日分しか見えません。
:::

::checks
