---
section: wrap-up
---

## このラボでできたこと

- ローカルのアカウントを Cognito User Pool に移行しました。EC2 はもうパスワードハッシュを保存せず、登録、確認、ロック、MFA は AWS が提供します。
- パブリックなアプリクライアントの設定と、「書き込み可能な属性」がなぜアプリの責任なのかを読み解きました。
- Cognito のトークンの発行者、署名アルゴリズム、サインアウトの意味を説明できるようになりました。

## 試験ポイントの振り返り

- User Pool と Identity Pool。ID・アクセス・リフレッシュトークン。認可コード＋ PKCE、パブリッククライアントと機密クライアント。
- ALB の `authenticate-cognito` は HTTPS リスナーでしか使えません。API Gateway HTTP API の JWT オーソライザー。
- Lambda トリガー（Pre Sign-up、Pre Token Generation、User Migration）。ソーシャルログインと SAML フェデレーション。マネージドログインのカスタムドメインの証明書は us-east-1 に置きます。
- ステートレスなセッションは Auto Scaling で水平スケールする前提です。Cognito と IAM Identity Center の使い分け。責任共有モデル。
- 参考：マネージドログイン（`COGNITO_LOGIN_MODE=managed`）には信頼された HTTPS ドメインが必要で、`sc-user-identity` で CloudFront のドメインを使って行います。
