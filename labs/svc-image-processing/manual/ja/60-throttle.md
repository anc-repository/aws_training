---
step: throttle
---

緊急ブレーキです。関数の予約済み同時実行を 0 に設定し（関数の一時停止と同じです）、プレビューで写真を 2～3 枚アップロードし、2 分間観察してから予約済み同時実行を削除します。

```bash {runsOn=workstation}
aws lambda put-function-concurrency --function-name "{{ var.functionName }}" --reserved-concurrent-executions 0
aws lambda get-function-concurrency --function-name "{{ var.functionName }}"
```

アプリのプレビューで写真を 2～3 枚アップロードしてから、関数の「モニタリング」ページを開き、`Throttles` と `AsyncEventsDropped` を見ます（メトリクスには 1～2 分ほどの遅れがあります）。

```bash {runsOn=workstation}
aws lambda delete-function-concurrency --function-name "{{ var.functionName }}"
aws lambda get-function-concurrency --function-name "{{ var.functionName }}"
```

:::warning
最後の `delete-function-concurrency` は必ず実行してください。予約済み同時実行が 0 のままだと、この後どの写真のサムネイルも生成されません。このステップと終了時のチェックで、削除されたことを確認します。
:::

:::expected
一時停止中は `Throttles` または `AsyncEventsDropped` に 0 以外の値が現れます。AWS のドキュメントによると、予約済み同時実行が 0 のとき、非同期イベントは再開まで待たずに破棄され、失敗時の送信先に送られます。
これらの写真は、その後アプリの照合タスクが処理します（再投入するか FAILED とマーク。実測で確認してください）。予約済み同時実行を削除すると、新しくアップロードした写真は正常に戻ります。
:::

:::saa{domain=performance confusable="预留并发 vs 预置并发"}
予約済み同時実行は、アカウントの同時実行クォータの一部を切り出したもので、最低保証であると同時に上限でもあります。0 にするのが「ブレーキ」です。プロビジョニングされた同時実行は実行環境を事前に初期化してコールドスタートをなくし、時間で課金されます。
新しいアカウントの同時実行クォータは低いことがあり、大量に予約するとほかの関数を圧迫します。
:::

::checks
