---
step: after
---

after を記録します。同じ読み取り負荷試験に `--ab` を付け、同じデプロイ内でリクエストごとに交互に実行します。A グループは `X-Compare-Bypass: cache` を付けて（キャッシュを読み書きしない）、B グループは通常どおり ElastiCache を使います。

```bash {runsOn=workstation}
npm run exp -- cache --label after --scenario feed-read --vus 20 --duration 120s --ab --upload
```

::experiment{module=cache id=feed-read label=after}

:::expected
B グループはヒット時のリクエストあたりのクエリが 0 回で、ヒット率は 1 に近くなります。A グループは before に近い値です。2 つのグループは同じ時間帯に動くため、「時間帯が違う」ことによる影響を除外できます。
:::

:::tip
単一プロセスでは、memory のヒット（プロセス内）のほうが ElastiCache（VPC 内での TLS 往復 1 回）より速くなります。共有キャッシュの価値は、複数プロセス・複数インスタンスでの一貫性と、再起動しても消えないことにあります。
:::

::checks
