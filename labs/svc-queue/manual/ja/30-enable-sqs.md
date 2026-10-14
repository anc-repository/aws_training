---
step: enable-sqs
---

ジョブキューを Amazon SQS に切り替えます。モジュールはジョブキュー `queue-jobs` とデッドレターキュー `queue-jobs-dlq`（このキューからの再処理だけを許可）を作成し、
メモリ内キューを空にしてから、**worker、api の順に再起動**し、最後にプローブのジョブを送って経路が通っていることを確認します。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable queue --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable queue
```
:::

:::why
**なぜ worker を先に再起動するのでしょうか？** api は SQS に切り替わった時点で新しいジョブをキューに送ります。そのとき worker がまだメモリ内キューを読んでいると、それらのジョブを処理する人がいません。
先に worker に SQS のロングポーリングを始めさせ、その後で api を切り替えれば、ジョブが宙に浮くことはありません。
:::

:::wait{typical=3 max=10}
2 つのキューのデプロイは通常 1 分もかかりません。メモリ内キューを空にして 2 回再起動するまで、もう少し待ちます。完了したらアプリのプレビューで写真を 1 枚アップロードしてください。経路ヘッダーに `queue=sqs:queued` が現れるはずです。
:::

::console-link[SQS コンソールでジョブキューを開く]{link=sqs.queue queueUrlEncoded="{{ var.queueUrl | url }}"}

:::expected
queue の状態が「正常」です。ジョブキューの再処理ポリシーはデッドレターキューを指し、最大受信数は 3、ロングポーリングは 20 秒、SSE-SQS で暗号化されています。デッドレターキューの保持期間は 14 日です。
:::

::checks
