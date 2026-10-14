---
section: cleanup
---

- プラットフォームは tls スタックを削除します。ACME エンドポイントを削除するときに、EAB、ドメイン検証、登録済みの ACME アカウントも一緒に削除されます。フォールバックの分岐の us-east-1 の統合証明書は、CloudFront から外された後に削除されます。
- 任意：終了前にラボ用インスタンスで、まだ有効な ACME 証明書を失効させます（ACM の `RevokeCertificate` はこれには効きません）：`scripts/module disable tls --param RevokeAcme=true`。
- 自分の DNS に追加した A レコード、検証用の CNAME（とフォールバックの分岐の CNAME）はプラットフォームには削除する権限がないので、自分で削除してください。
- HSTS を有効にした場合、ブラウザーは `max-age` の間それを記憶します。終了前に `TLS_FORCE_HTTPS` を無効にしてください。
- 期限切れの ACME 証明書は ACM が 1 年後に自動で削除します。コンソールで ACME のフィルター条件を使い、残っていないことを確認してください。
