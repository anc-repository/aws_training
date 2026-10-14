---
step: spof
---

単一障害点の訓練です。ラボ用インスタンスを停止してサイトの様子を見てから、また起動します。まず**ワークベンチのターミナル**で 5 秒ごとの確認を始めておきます（動かしたままにします）。

```bash {runsOn=workstation}
while true; do printf "%s " "$(date +%T)"; curl -sk -o /dev/null -m 4 -w "%{http_code}\n" "https://{{ target.publicIp }}/api/health/live" || echo down; sleep 5; done
```

:::method{kind=console default}
::console-link[ラボ用インスタンスを開く]{link=ec2.instance instanceId="{{ target.instanceId }}"}

1. 「インスタンスの状態 → インスタンスを停止」を選び、状態が「停止済み」になるのを待って、ワークベンチの確認結果を見ます。
2. 「インスタンスの状態 → インスタンスを開始」を選び、状態が「実行中」になって確認結果が 200 に戻るのを待ちます。
3. 「パブリック IPv4 アドレス」が変わっていないことを確認します。
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws ec2 stop-instances --instance-ids {{ target.instanceId }}
aws ec2 wait instance-stopped --instance-ids {{ target.instanceId }}
aws ec2 start-instances --instance-ids {{ target.instanceId }}
aws ec2 wait instance-running --instance-ids {{ target.instanceId }}
```
:::

:::warning
停止したら**必ずまた起動してください**。想定内の中断の時間枠は最大 15 分です。時間枠が終わってもインスタンスが起動していないと、チェックはチャネルの中断と判断し、最終確認に合格できません。カウントダウンはその間も進みます。
:::

:::wait{typical=10 max=20}
インスタンスの停止と起動にはそれぞれ 1～数分かかります。CloudTrail のイベント履歴にはさらに数分から十数分の遅れがありますが、このステップのチェックは自動で再試行します。
:::

:::expected
停止中は確認がすべて失敗します（サイト全体が使えません）。起動すると 200 に戻り、Elastic IP は変わりません。
:::

::checks
