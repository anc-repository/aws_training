---
step: enable
---

インスタンスロールを有効にします。モジュールは読み取り専用ポリシー `cloudalbum-{{ session.env }}-iam` をデプロイして `CloudAlbumAppRole` にアタッチし、`IAM_CREDENTIALS=role` を書き込んでアプリを再起動します。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable iam --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable iam
```
:::

:::wait{typical=2 max=10}
ポリシーのスタックをデプロイし、ポリシーをアタッチして再起動します。IAM の変更は結果整合性なので、プローブが新しい権限を認識するまで数秒かかることがあります。
:::

:::expected
iam の状態は「正常」で、detail には `assumed-role/CloudAlbumAppRole/<インスタンス ID>` と `ASIA` というプレフィックスが表示されます。ロールの権限の一覧に `cloudalbum-{{ session.env }}-iam` が加わっています。
:::

:::saa{domain=secure confusable="GetCallerIdentity vs 授权"}
`sts:GetCallerIdentity` には権限が一切不要で、明示的な Deny でも止められません。証明できるのは「認証に成功し、自分が誰か」だけで、「権限がある」ことは証明できません。
そのため、モジュールのヘルスチェックには、ポリシーで制約された呼び出し（`iam:GetRole`）をもう 1 つ加えています。
:::

::checks
