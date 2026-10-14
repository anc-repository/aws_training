---
step: inspect
---

「誰が関数を起動し、関数は何ができ、失敗はどこへ行くか」を読み解きます。これらの設定はモジュールスタックが管理しているので、**見るだけで変更しないでください**。

:::method{kind=console default}
::console-link[サムネイル関数を開く]{link=lambda.function functionName="{{ var.functionName }}"}

1. 「関数の概要」：トリガーは EventBridge のルール `{{ var.ruleName }}` で、「送信先」は失敗時の SQS キューです。
2. 「設定 → アクセス権限」：実行ロールは、元画像バケットの `raw/*` の読み取りと表示用バケットの `variants/*` への書き込みだけを許可し、失敗キューと結果キューにメッセージを送信できます。
3. 「設定 → 非同期呼び出し」：再試行 2 回、イベントの最大有効期間 1 時間、失敗時の送信先は `image-processing-failures` です。
4. EventBridge のルールを開きます。イベントパターンは元画像バケットの `raw/` プレフィックスの `Object Created` だけに一致し、ターゲットには再試行ポリシーとデッドレターキューの両方が設定されています。
5. 「モニタリング → CloudWatch ログを表示」：呼び出しごとの最後にある `REPORT` 行には `Duration`、`Billed Duration`、`Max Memory Used` が含まれ、コールドスタートのときは `Init Duration` もあります。
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws events describe-rule --name "{{ var.ruleName }}" --query EventPattern --output text
aws events list-targets-by-rule --rule "{{ var.ruleName }}"
aws lambda get-function-event-invoke-config --function-name "{{ var.functionName }}"
aws logs tail "{{ var.logGroup }}" --since 30m --filter-pattern REPORT
```
:::

:::why
**失敗は 2 層、行き先は 1 つ**：ルールのターゲットにあるデッドレターキューは「EventBridge が Lambda に配信できない」場合（たとえば権限が削除された）を扱い、関数の失敗時の送信先は
「Lambda の実行が失敗し、再試行も使い切った」場合を扱います。どちらも同じ失敗キューに集まり、アプリの照合タスクがそれを読み取って再投入するか FAILED とマークします。
:::

:::saa{domain=cost confusable="S3 事件通知 vs EventBridge"}
S3 のイベント通知では、同じイベントタイプと重なるプレフィックスに送信先を 1 つしか持てません。EventBridge にまとめて配信すれば、複数のコンシューマーがそれぞれのスタックでルールを作れ（コレオグラフィー）、互いにぶつかりません。
入力と出力を分ける（元画像バケットの `raw/` → 表示用バケットの `variants/`）ことが、再帰呼び出しを防ぐ根本的な方法です。
:::

::checks
