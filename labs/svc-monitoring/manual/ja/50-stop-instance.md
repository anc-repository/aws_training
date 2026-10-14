---
step: stop-instance
---

（任意）今回はサービスではなく、ラボ用インスタンスそのものを停止します。ワークベンチのスクリプトがあなたの ID で `aws ec2 stop-instances` を呼び出し、4 分間止めてから起動し、
Session Manager の管理チャネルが復旧するのを待ちます。インスタンス ID も Elastic IP も変わりません。

```bash {runsOn=workstation}
npm run exp -- monitoring --label stop-instance --scenario kill-test --param phase=instance --param instanceDownSec=240 --param instanceId={{ target.instanceId }} --upload
```

::experiment{module=monitoring id=kill-test label=stop-instance}

:::warning
インスタンスの停止中は、ラボ用インスタンスのターミナルもローカルのチェックも使えず、画面には「想定内の中断」と表示されます。スクリプトはバックグラウンドで動き、終了前に必ずインスタンスを起動し直します。ターミナルを先に閉じてしまった場合は、
EC2 コンソールでインスタンスが「実行中」であることを確認してください。他のステップに進む前に、復旧を待つ必要があります。
:::

::console-link[EC2 コンソールでラボ用インスタンスを見る]{link=ec2.instance instanceId="{{ target.instanceId }}"}

:::expected
`app-heartbeat` が ALARM になり、メールが届きます。ローカル側にはもちろん何もありません。停止したそのインスタンスの上にあるからです。
:::

::checks
