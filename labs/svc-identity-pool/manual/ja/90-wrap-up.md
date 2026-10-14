---
section: wrap-up
---

## このラボでできたこと

- F14 の認可を「アプリのコードがパートごとにプレフィックストークンを検証する」から「IAM ポリシー変数を S3 側で適用する」に切り替えました。ブラウザーは自分のプレフィックスにしか書き込めない STS の一時的な認証情報を持ち、パートをステージングバケットに直接送ります。
- 権限外アクセスの実験で 2 種類の拒否を確認しました。アプリが返す 403 `UPLOAD_PREFIX_DENIED` と、S3 が返す `AccessDenied` です。
- バックエンドへのリクエスト数を定量化しました。プレフィックストークンではパートの数に比例して増え、一時的な認証情報ではファイルの数にしか関係しません。
- 認証済みロールの信頼ポリシー（aud、amr）と許可ポリシー（`${cognito-identity.amazonaws.com:sub}`）を読み解き、サーバー側の CopyObject による取り込みの代償を確認しました。

## 試験ポイントの振り返り

- User Pool と Identity Pool の役割分担。ウェブ ID フェデレーションと `AssumeRoleWithWebIdentity`。デベロッパー認証 ID（auth=local のときは `GetOpenIdTokenForDeveloperIdentity`）。
- ポリシー変数 `${cognito-identity.amazonaws.com:sub}` は Identity ID であり、User Pool の sub ではないこと。信頼ポリシーの `aud`、`amr` の条件。ゲスト ID のリスク。
- 署名付き URL、アプリが署名するトークン、一時的な認証情報のトレードオフ：認可の場所、リクエスト回数、取り消しの方法、サーバー側の制御力。
- S3 の CORS では `ETag` の公開が必須。マルチパートアップロードと、ライフサイクルルールによる未完了のパートの削除。SSE-KMS ではマルチパートアップロードに `kms:Decrypt` も必要。
