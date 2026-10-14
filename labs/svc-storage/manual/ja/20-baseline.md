---
step: baseline
---

before を記録します。10 並列、1 枚 5 MB、60 秒間のアップロード負荷テストを行い、同時に毎秒数回タイムラインを読み込んで、アップロードが他の API に与える影響を観察します。

```bash {runsOn=workstation}
npm run exp -- storage --label before --scenario upload-burst --param fileMb=5 --duration 60s --upload
```

::experiment{module=storage id=upload-burst label=before}

:::tip
モジュールのドキュメントの既定パラメーターは 20 MB、120 秒です。カードでは 5 MB、60 秒にしています。L0 の before では元画像が 20 GiB のデータボリュームに書き込まれるため、既定のパラメーターではディスクのしきい値に近づいて後続のステップに影響するおそれがあります。方向と桁についての結論は変わりません。
:::

::checks
