---
step: after
---

after を記録します。ステップ 2 とまったく同じ読み書き混在の負荷を、今度は RDS 上のデータベースに対して実行します。

```bash {runsOn=workstation}
npm run exp -- database --label after --scenario mixed-rw --vus 10,50 --upload
```

::experiment{module=database id=mixed-rw label=after}

:::expected
同時実行数 10 では 1 回のリクエストが SQLite よりわずかに遅くなります（ネットワーク往復が 1 回増えるため）。同時実行数 50 ではレイテンシーが緩やかに上がるだけで、イベントループ遅延のスパイクは出なくなります。
:::

::checks
