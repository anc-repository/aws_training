---
step: baseline
---

before を記録します。小さな画像 200 枚を一気にアップロードし、ランナーが 30 秒目に api を再起動して（リリースを模擬）、キューが空になるのを待ってから失われたジョブを数えます。

```bash {runsOn=workstation}
npm run exp -- queue --label before --scenario upload-burst --upload
```

::experiment{module=queue id=upload-burst label=before}

:::expected
レポートの `biz.jobs_lost` が 0 より大きくなります。再起動の時点でメモリ内キューにあったジョブが失われたためです。
:::

:::tip
実行中にラボ用インスタンスのターミナルを開き、`top` で api プロセスと worker プロセスの CPU を見てください。ジョブの処理と API が 1 台のマシンの CPU を共有しています。
:::

::checks
