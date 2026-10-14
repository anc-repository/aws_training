---
step: replica
---

（任意）リードレプリカです。モジュールに非同期レプリケーションのレプリカを追加し、アプリの読み取りクエリをレプリカのエンドポイントに送ります。レプリカは 3 台目の時間課金インスタンスで、作成には 10 数分以上かかります。

```bash {runsOn=workstation}
scripts/module enable database --param MultiAz=true --param CreateReadReplica=true
```

レプリカが利用可能になったら、リクエストごとの A/B で、プライマリから読む場合とレプリカから読む場合を比べます。

```bash {runsOn=workstation}
npm run exp -- database --label after --scenario replica-read --ab --upload
```

::experiment{module=database id=replica-read label=after}

:::expected
レプリカから読むグループのリクエストでは、経路ヘッダーの database セグメントがレプリカを指し、プライマリの読み取り負荷が下がります。書き込み直後にレプリカを読むと、古いデータが返ることがあります（非同期レプリケーションの遅延）。
:::

::checks
