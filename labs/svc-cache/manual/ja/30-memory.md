---
step: memory
---

（任意）まずローカル階層 memory に切り替えます。Node のプロセスごとに LRU を 1 つずつ持ち、AWS のリソースは必要ありません。

```bash {runsOn=workstation}
scripts/module enable cache --driver memory
```

同じ読み取り負荷試験をもう一度実行します。

```bash {runsOn=workstation}
npm run exp -- cache --label memory --scenario feed-read --vus 20 --duration 120s --upload
```

::experiment{module=cache id=feed-read label=memory}

:::expected
ヒット時のリクエストあたりのクエリは 0 回で、レイテンシーはマイクロ秒単位（プロセス内）です。この後の ElastiCache よりも速くなります。
:::

:::why
**プロセス内キャッシュの代償は、複数プロセスになって初めて現れます**。2 つのプロセスがそれぞれキャッシュを持つと、書き込み後、TTL の間はおよそ半分のリクエストが古いデータを読みます。プロセスを再起動すればキャッシュは空になります。
このカードの開始状態には api プロセスが 1 つしかないため、この不整合は見えません。複数インスタンスの版は `sc-db-performance` と `sc-elastic-web` を参照してください。
:::

::checks
