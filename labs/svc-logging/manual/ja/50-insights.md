---
step: insights
---

もう少し 5xx を発生させてから、コンソールで Logs Insights を使って集計し、メトリクスフィルターが生成したメトリクスを探します。

1. ワークベンチで before と同じ負荷をもう一度実行します（アップロードはせず、5xx を発生させるためだけです。障害は 120 秒後に自動で解除されます）。

```bash {runsOn=workstation}
npm run exp -- logging --label after --scenario query-compare
```

:::method{kind=console default}
2. CloudWatch → **Logs Insights** →「クエリ」のドロップダウンで保存済みのクエリ `cloudalbum-{{ session.env }}/5xx-by-route`（ロググループ
   `/cloudalbum/{{ session.env }}/nginx`）を選び、時間範囲を「過去 1 時間」にして実行します。結果パネルの下の統計で、一致したレコード数、スキャンしたレコード数、スキャンしたバイト数を確認します。
3. CloudWatch → **メトリクス** → すべてのメトリクス → 名前空間 `CloudAlbum/Logs` → `Nginx5xx` を見つけ、「合計」、期間 1 分でグラフにします。
:::

:::wait{typical=5 max=10}
メトリクスフィルターは取り込み時に照合します。status ≥ 500 の行に初めて一致した後でメトリクスが一覧に現れるため、通常は数分かかります。
:::

:::expected
`/api/lab/now` の errors がレポートの 5xx の件数と一致します。`Nginx5xx` メトリクスにデータポイントがあります。
:::

:::saa{domain=resilient confusable="指标过滤器 vs Logs Insights"}
メトリクスフィルターは**作成後**に取り込まれたログにだけ適用され、過去にはさかのぼりません。過去のデータを集計するには Logs Insights（スキャン量で課金）を使います。
メトリクスフィルターが生成したメトリクスには、そのままアラームを設定できます（svc-monitoring）。
:::

::checks
