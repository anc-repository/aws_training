---
step: whoami
---

after を記録します。同じ ID の確認を、今度はアプリがインスタンスロールを使った状態で行います。

```bash {runsOn=workstation}
npm run exp -- iam --label after --scenario whoami --upload
```

::experiment{module=iam id=whoami label=after}

:::expected
呼び出し元は `arn:aws:sts::<アカウント>:assumed-role/CloudAlbumAppRole/<インスタンス ID>` で、キーのプレフィックスは `ASIA`、有効期限まで数時間あり、ディスク上の長期キーの数は 0 です。
:::

:::why
**一時的な認証情報のほうが安全なのはなぜでしょうか？** 有効期限があり、EC2 が期限切れの前に自動でローテーションし、SDK も自動で更新します。存在するのは IMDS とプロセスのメモリの中だけで、スナップショットやバックアップには入りません。
漏えいが疑われるときは、ロールに対して「アクティブなセッションの取り消し」（`aws:TokenIssueTime` で古いセッションを拒否）を行えばよく、ロールを削除する必要はありません。
:::

::checks
