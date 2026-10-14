---
step: failures
---

失敗の経路です。壊れた JPEG（正しいファイルヘッダー + ランダムなバイト）をアップロードします。これは恒久的なエラーで、何回再試行しても成功しません。そのため関数はそのまま FAILED を書き戻し、例外も投げず、再試行もしません。

```bash {runsOn=workstation}
npm run exp -- image-processing --label after --scenario failures --param count=3 --upload
```

::experiment{module=image-processing id=failures label=after}

:::expected
3 枚の写真はすべてすぐに FAILED になります（`scenario.notFailed` は 0）。失敗キューは空のままです。
:::

:::why
**恒久的なエラーと一時的なエラーは分けて扱う必要があります**。一時的なエラー（下流のタイムアウト、スロットリング）は関数が例外を投げ、Lambda が非同期で 2 回再試行し（間隔はおよそ 1 分、2 分）、
使い切ったら失敗時の送信先に送り、アプリが照合します。恒久的なエラーを再試行しても呼び出しの料金が無駄になるだけなので、関数自身が判定して結果を直接書き戻すべきです。
:::

:::tip
参考：このモジュールの関数は、環境変数 `FAULT_RATE`（0～1）に応じた割合で一時的なエラーを投げられます。手動でデモするには `aws lambda update-function-configuration`
で関数の環境変数を変更する必要があります（既存の変数をすべて含めること）。このカードでは操作を求めていません。デモを行った場合は、終了前に
`scripts/module enable image-processing --param ResultChannel=queue` を再実行して設定を元に戻してください。このステップのチェックは `FAULT_RATE` がないことを確認し続けます。
:::

::checks
