---
step: resolution
---

（任意）同じ 3 分間の CPU スパイクが、ローカルの 10 秒サンプルと EC2 の基本モニタリング（5 分）でそれぞれどう見えるかを比べます。

```bash {runsOn=workstation}
npm run exp -- monitoring --label after --scenario resolution --fault-via ssm --instance-id {{ target.instanceId }} --upload
```

::experiment{module=monitoring id=resolution label=after}

詳細モニタリングと比べたい場合は、有効にしてからもう一度行います（詳細モニタリングはインスタンスごとに課金されるので、終わったら必ず元に戻してください）。

```bash {runsOn=workstation}
scripts/module enable monitoring --param AlertEmail={{ learner.inputs.notify-email }} --param DetailedMonitoring=true
npm run exp -- monitoring --label after --scenario resolution --fault-via ssm --instance-id {{ target.instanceId }} --upload
scripts/module enable monitoring --param AlertEmail={{ learner.inputs.notify-email }} --param DetailedMonitoring=false
```

:::expected
ローカルの `host.loadavg1` はスパイクの間に十数点あります。基本モニタリングの `biz.ec2_points_300` は 1～2 点だけで、スパイクは平均されて小さな坂になります。
詳細モニタリングの `biz.ec2_points_60` は明らかに多くなります。
:::

::checks
