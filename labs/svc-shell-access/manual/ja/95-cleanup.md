---
section: cleanup
---

- 自動回収ではまず `scripts/module disable shell-access` と同等の手順を実行します。バックアップに従って `SSM-SessionManagerRunShell` を**元に戻し**、`cloudalbum-ops`
  と sudoers の設定断片を削除し、ポリシーをデタッチし、スタックを削除します。セッションログのロググループは `DeletionPolicy: Retain` なので、回収処理が削除します。
- `SSM-SessionManagerRunShell` はアカウント × リージョン単位のシングルトンで、同じリージョンでデフォルトのドキュメントを使うすべてのセッションに影響します。コンソールの Session Manager の「設定」ページで手動で変更しないでください。
- トラブルシューティングのために一時的にセキュリティグループに 22 のルールを追加した場合は、終了前に削除してください（最終確認でチェックされます）。
- ポートフォワーディングのセッションはワークベンチで Ctrl+C を押して終了します。シェルセッションは 20 分間操作がないと自動で切断されます（セッション設定の `idleSessionTimeout`）。
- スタンドアロンで使う場合（プラットフォーム以外）、無効にするときは 22 を明示的に開け直す必要があります：`scripts/module disable shell-access --reopen-ssh`（運用 IP が変わった場合は `--param SshIngressCidr=<ip>/32` も付けます）。
