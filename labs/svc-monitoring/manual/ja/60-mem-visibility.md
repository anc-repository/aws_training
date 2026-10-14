---
step: mem-visibility
---

EC2 が提供するのは仮想化レイヤーから見えるメトリクスだけです。まず CloudWatch でこのラボ用インスタンスのメモリのメトリクスを探します。

```bash {runsOn=workstation}
aws cloudwatch list-metrics --namespace AWS/EC2 --dimensions Name=InstanceId,Value={{ target.instanceId }} --query "Metrics[].MetricName" --output text
aws cloudwatch list-metrics --namespace CWAgent --metric-name mem_used_percent --dimensions Name=InstanceId,Value={{ target.instanceId }}
```

次に共有の障害注入で 256 MiB のメモリを 5 分間占有し、3 本のグラフを比較します。

```bash {runsOn=workstation}
npm run exp -- monitoring --label after --scenario mem-visibility --param mib=256 --upload
```

::experiment{module=monitoring id=mem-visibility label=after}

:::expected
`AWS/EC2` には CPUUtilization、NetworkIn、StatusCheckFailed などがありますが、メモリはありません。`CWAgent` には `mem_used_percent` があります。
レポートの `biz.ec2_mem_points` は 0、`biz.cwagent_mem_points` は 0 より大きく、`biz.local_mem_delta_pct` は CWAgent の上昇幅と近い値です。
:::

:::saa{domain=performance confusable="详细监控 vs Agent 指标"}
詳細モニタリングは EC2 のメトリクスの粒度を 5 分から 1 分にするだけで、メモリやディスクの使用率は増えません。これらは OS 内のエージェントが送信する必要があります。
:::

::checks
