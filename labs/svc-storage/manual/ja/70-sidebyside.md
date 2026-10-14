---
step: sidebyside
---

（任意）同じ時間に同じインスタンスで local と s3 の 2 つの経路を交互に使ってアップロードします。書き込むのは `lab/` プレフィックスだけで、終了後に自動でクリーンアップされます。

```bash {runsOn=workstation}
npm run exp -- storage --label after --scenario upload-sidebyside --param fileMb=5 --upload
```

::experiment{module=storage id=upload-sidebyside label=after}

:::expected
同じ時間帯での 2 つの経路の「アップロード完了」までの時間とラボ用インスタンスの受信バイトの差は、before/after と同じ方向の結論を示します。
:::

::checks
