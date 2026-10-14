---
step: enable
---

CloudWatch を組み込みます。モジュールは次のものを作成します。SNS トピック `ops-alarms` とあなたのメールサブスクリプション、ダッシュボード `CloudAlbum-{{ session.env }}-Overview`、約 11 個のアラーム
（ステータスチェック、CPU、CPU クレジット、メモリ、データディスク、5xx の割合、p95、2 つのハートビート、複合アラーム）、アプリ用のポリシー。さらにラボ用インスタンスに CloudWatch エージェントをインストールし、
メモリとディスクの設定断片を配置します。アプリは「ローカル + 60 秒ごとのまとめた PutMetricData」に変わります。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable monitoring --param AlertEmail={{ learner.inputs.notify-email }} --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable monitoring --param AlertEmail={{ learner.inputs.notify-email }}
```
:::

:::wait{typical=5 max=15}
スタックのデプロイには通常 2～3 分、エージェントのインストールと api・worker の再起動にさらに 1～2 分かかります。完了直後の monitoring は黄色の「订阅未确认：告警只在控制台可见」（サブスクリプション未確認：アラームはコンソールでしか見えない）です。
これは待機であり、失敗ではありません。次のステップでメールボックスから確認すれば解消します。
:::

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.monitoring | {driver, status, detail}'
systemctl is-active amazon-cloudwatch-agent
```

:::expected
`driver` は `cloudwatch` です。detail には、最後に送信が成功した時刻、「Agent 运行中」（エージェント動作中）、サブスクリプションの状態が順に表示されます。エージェントは `active` です。
CloudWatch コンソールの「アラーム」に、プレフィックスが `cloudalbum-{{ session.env }}-` のアラームが表示され、`app-heartbeat` の欠落データの処理は「不正（しきい値を超えている）として処理」です。
:::

:::why
**なぜディメンションは Route、Module、Driver、Outcome、Job だけなのでしょうか？** ディメンションの組み合わせはそれぞれが別々に課金されるカスタムメトリクスです。requestId や userId を
ディメンションにするとメトリクスの数が爆発します。このようなカーディナリティの高いフィールドは、ログか EMF のプロパティにしか入れられません。
:::

:::saa{domain=resilient confusable="指标告警 vs 复合告警"}
`ec2-status-system` アラームには EC2 の `recover` アクションと SNS の両方が付いています。複合アラーム `app-unhealthy` は通知しかできず、EC2 のアクションは実行できません。
:::

::checks
