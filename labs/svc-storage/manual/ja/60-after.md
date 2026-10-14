---
step: after
---

before とまったく同じパラメーターでもう一度測定します。

```bash {runsOn=workstation}
npm run exp -- storage --label after --scenario upload-burst --param fileMb=5 --duration 60s --upload
```

::experiment{module=storage id=upload-burst label=after}

:::expected
ラボ用インスタンスのネットワーク受信バイトは KB 単位の署名リクエストだけになり、アップロード量に応じて増えなくなります。API プロセスの CPU とタイムラインの p95 はほぼ変わりません。before と after の 2 つの結果がどちらも有効で、比較できます。
:::

:::saa{domain=resilient}
S3 Standard はオブジェクトを複数のアベイラビリティーゾーンに冗長保存します（公式ドキュメントを確認してください）。EBS ボリュームは 1 つのアベイラビリティーゾーン内でしか冗長化されません。S3 は容量の事前確保が不要ですが、EBS ボリュームのサイズは固定です。
:::

::checks
