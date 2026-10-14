---
step: enable
---

Lambda を組み込みます。`scripts/module` は `lambdas/image-thumbnail` をパッケージング（esbuild ＋ linux-arm64 用の sharp）してツールチェーンのバケットにアップロードし、
関数、ロググループ、非同期呼び出しの設定、EventBridge のルール、失敗キューと結果キューをデプロイします。その後 worker、api の順に再起動し、最後にエンドツーエンドのプローブを実行します。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable image-processing --param ResultChannel=queue --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable image-processing --param ResultChannel=queue
```
:::

:::wait{typical=4 max=15}
パッケージング、アップロード、デプロイ、エンドツーエンドのプローブを行います。完了したら、アプリのプレビューで写真を 3 枚アップロードし、実際の Lambda の処理経路をプラットフォームに見せてください。
:::

:::expected
image-processing の状態は「正常」です。アップロードのリクエストの経路ヘッダーに `image-processing=lambda:async` が現れ、写真の詳細のバッジには「缩略图由 AWS Lambda 生成」（サムネイルは AWS Lambda が生成）と表示されます。
:::

:::why
**なぜ書き戻しに HMAC のコールバックではなく結果キューを選ぶのでしょうか？** コールバックでは Lambda がインターネットからラボ用インスタンスにアクセスする必要があります（DEP-021 によりモジュールは degraded になり、インバウンドのポートをインターネットに開く必要もあります）。
結果キューなら EC2 が自分からロングポーリングするので、インバウンドのトラフィックは一切不要で、ラボ用インスタンスが止まっていても結果はキューに残ります。HMAC コールバックの設計はモジュールのドキュメントを参照してください（参考）。
:::

::checks
