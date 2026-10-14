---
section: wrap-up
---

## このラボでできたこと

- タイムラインに ElastiCache（Valkey）のキャッシュアサイドを追加し、同じデプロイ内でのリクエストごとの A/B で、ヒット時にクエリ回数が 0 になることを証明しました。
- ElastiCache が VPC 内からしかアクセスできないこと、「セキュリティグループがセキュリティグループを参照する」許可の仕組みを自分の手で確かめました。

## 試験ポイントの振り返り

- キャッシュアサイドとライトスルー、TTL と無効化の戦略。キャッシュブレイクダウン、キャッシュアバランシェ、single-flight。
- Valkey / Redis OSS と Memcached。クラスターモードの有効と無効。Serverless とノードモードの課金の違い。マルチ AZ にはレプリカが 1 つ以上必要です。
- VPC 内からのみアクセス可能、TLS、AUTH / RBAC。キャッシュの階層：CloudFront、API Gateway のキャッシュ、ElastiCache、DAX、リードレプリカ。
- セッションの外出しは、Auto Scaling グループをステートレスにする前提です。
