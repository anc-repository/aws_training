---
step: after-alert
---

after を記録します。同じ合成 5xx の負荷で、今回はローカル評価器と CloudWatch のアラームを並べて計時し、両方が ALARM になるまで続けます。

```bash {runsOn=workstation}
npm run exp -- monitoring --label after --scenario time-to-alert --upload
```

::experiment{module=monitoring id=time-to-alert label=after}

:::expected
`biz.local_detect_sec` は before と同程度です（ローカル側はそのまま動いています）。`biz.cw_alarm` は 1 で、`biz.cw_detect_sec` は分単位です。
その後、件名に `ALARM: "cloudalbum-{{ session.env }}-app-5xx-rate"` を含むメールが届きます。
:::

:::saa{domain=resilient confusable="周期 × 评估期 vs 出现延迟"}
アラームの遅延 ≈ 期間 × M of N のデータポイント数 + メトリクスが現れるまでの遅延。期間を短くすれば（高解像度メトリクス）速くなりますが、費用は上がります。
:::

::checks
