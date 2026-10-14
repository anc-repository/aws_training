---
step: after
---

after を記録します。ステップ 1 とまったく同じアップロード負荷で、今度はサムネイルを Lambda が生成します。

```bash {runsOn=workstation}
npm run exp -- image-processing --label after --scenario upload-burst --vus 20 --duration 60s --upload
```

::experiment{module=image-processing id=upload-burst label=after}

:::expected
complete の p95 は数十ミリ秒程度まで下がり、`host.cpu.p95` ははっきり下がります。`biz.cold_starts` は 0 より大きく（最初の写真でコールドスタートが起きる）、`biz.jobs_lost` は 0 です。
:::

:::tip
`--ab` を付けると同じ時間帯で比較できます。写真の半分に `X-Compare-Bypass: image` を付けて API のプロセス内でその場で処理し、後から届く Lambda の結果は冪等に無視されます。
:::

::checks
