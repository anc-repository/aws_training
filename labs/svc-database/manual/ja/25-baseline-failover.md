---
step: baseline-failover
---

before の障害区間を記録します。ランナーは書き込みを続け、30 秒目に api を再起動します（SQLite の階層では「データベース障害」はアプリのプロセス再起動と同じことしかできません）。

```bash {runsOn=workstation}
npm run exp -- database --label before --scenario failover --upload
```

::experiment{module=database id=failover label=before}

:::expected
レポートに書き込み失敗の区間が現れ、その長さは api の再起動にかかる時間とほぼ同じです。
:::

::checks
