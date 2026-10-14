---
step: after-kill
---

after を記録します。before とまったく同じ「サービスを 5 分間停止」です。今回も止めるのは api と worker で、ローカル評価器はやはり沈黙しますが、CloudWatch にはハートビートが届かなくなるため、
`app-heartbeat` が ALARM になって SNS でメールが送られます。

```bash {runsOn=workstation}
npm run exp -- monitoring --label after --scenario kill-test --param phase=service --fault-via ssm --instance-id {{ target.instanceId }} --upload
```

::experiment{module=monitoring id=kill-test label=after}

:::expected
`biz.local_alerts_during_outage` は 0 のままです。`biz.cw_heartbeat_alarm` は 1、`biz.cw_detect_sec` は約 3～4 分です。停止中に ALARM メールが届き、
復旧の数分後に OK メールが届きます。
:::

:::saa{domain=resilient confusable="missing vs breaching"}
`TreatMissingData` のデフォルトは `missing` です。データがないとアラームは INSUFFICIENT_DATA で止まり、通知されません。ハートビート型のアラームは必ず `breaching` にします。
:::

::checks
