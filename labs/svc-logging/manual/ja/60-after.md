---
step: after
---

after を記録します。before と同じ障害と負荷で、今回は 2 つのクエリをローカルと CloudWatch の両側で並べて実行します。

```bash {runsOn=workstation}
npm run exp -- logging --label after --scenario query-compare --upload
```

::experiment{module=logging id=query-compare label=after}

:::expected
`agreeLocal` と `agreeCloudwatch` がどちらも真になります。ローカルの走査、CloudWatch の Insights、クライアントが受け取った 503 の数が一致します。レポートには両側の所要時間が示され、
Insights についてはスキャンしたバイト数も示されます。インスタンスが 1 台でデータが少ないときは、ローカルの走査のほうが速いことがよくあります。CloudWatch の強みは、インスタンスをまたげること、インスタンスがなくなっても検索できること、集計できることであり、この 1 回の速さではありません。
:::

:::tip
`npm run exp:report -- logging --experiment query-compare` で before と after を比較するレポートを生成できます。
:::

::checks
