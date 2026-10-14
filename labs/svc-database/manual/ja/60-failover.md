---
step: failover
---

フェイルオーバーです。ランナーは書き込みを続け、30 秒目に `aws rds reboot-db-instance --force-failover` を実行します（障害スクリプトはワークベンチであなたの権限で実行され、インスタンス ID が必要です）。

```bash {runsOn=workstation}
export DB_INSTANCE_ID={{ var.dbInstanceId }}
npm run exp -- database --label after --scenario failover --upload
```

::experiment{module=database id=failover label=after}

:::wait{typical=3 max=10}
フェイルオーバー中のインスタンスの状態は rebooting です。完了すると元のスタンバイがプライマリになり、エンドポイントの DNS が新しいプライマリを指します。
:::

:::expected
レポートに書き込み失敗の区間が現れ、その後アプリが自動で再接続します。ページ上部には一時的に「数据库重连中」（データベースに再接続中）と表示されます。プライマリはステップ 4 で記録したスタンバイの AZ に移っています。
:::

:::tip
フェイルオーバー後は、プライマリとラボ用インスタンスが別の AZ になる場合があり、1 回のクエリのレイテンシーが少し上がります。これは AZ をまたぐネットワーク往復によるもので、障害ではありません。
:::

::checks
