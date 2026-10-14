---
step: baseline
---

before を記録します。20 人の同時ユーザーが 60 秒間、4000×3000 の JPEG をアップロードし続けます。1 枚ごとに「登録 → S3 への PUT → complete → READY になるまでポーリング」を最後まで行います。

```bash {runsOn=workstation}
npm run exp -- image-processing --label before --scenario upload-burst --vus 20 --duration 60s --upload
```

::experiment{module=image-processing id=upload-burst label=before}

:::expected
complete API の p95 は秒単位で、`host.cpu.p95` は 100% 近くになります。サムネイルの準備完了までの時間は、complete の所要時間とほぼ同じです。
:::

:::tip
「隣人への影響」もあわせて見たい場合は、`npm run exp -- image-processing --label before --scenario neighbor --upload` を追加で実行できます（任意）。
同じアップロード負荷の中でタイムラインを毎秒 5 回読み、`GET /api/feed` の p95 を見ます。enable した後は、同じシナリオでは after しか記録できません。
:::

::checks
