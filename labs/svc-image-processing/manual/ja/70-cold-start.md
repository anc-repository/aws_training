---
step: cold-start
---

（任意）コールドスタートです。関数を 15 分間アイドルにしてから写真を 1 枚アップロードし、続けて 5 枚アップロードしてから、CloudWatch Logs Insights で `Init Duration` を集計します。
残り時間が 30 分未満なら、このステップはスキップしてください。

```bash {runsOn=workstation}
aws logs start-query --log-group-name "{{ var.logGroup }}" --start-time $(( $(date +%s) - 3600 )) --end-time $(date +%s) --query-string 'filter @type = "REPORT" | stats count(@initDuration) as coldStarts, avg(@initDuration) as avgInit, pct(@duration, 95) as p95 by bin(5m)'
```

返された `queryId` で結果を読み取ります。

```bash {runsOn=workstation}
aws logs get-query-results --query-id <前のコマンドが返した queryId>
```

:::tip
プロビジョニングされた同時実行と比べたい場合は、バージョンを発行してプロビジョニングされた同時実行を 1 つ設定し、上の測定を繰り返した後で**すぐに削除**してください。プロビジョニングされた同時実行は時間で課金され、設定している間ずっと料金が発生します。
:::

:::expected
アイドル後の 1 枚目には `Init Duration`（数百ミリ秒程度）があります。その直後に続けてアップロードした写真は実行環境を再利用するため、`Init Duration` はありません。
:::

::checks
