---
section: wrap-up
---

## このラボでできたこと

- コストのガードレールを組みました。プロジェクト予算（タグで絞り込み）とアカウント予算（受け皿）に、実績と予測の 2 段階の通知を付け、メールと SNS に送るようにしました。
- 「速いが粗い」ローカルの一覧と「正確だが遅い」Budgets を並べて見て、両側が一致しない理由を理解しました。
- 単価はあなたが出典を明記して書き写したものだけで、このプロジェクトは価格を一切組み込んでいないことを確認しました。

## 試験ポイントの振り返り

- AWS Budgets（コスト、使用量、RI / Savings Plans の予算、実績と予測のアラート、Budgets Actions）と、Cost Explorer、コストと使用状況レポート、
  Cost Anomaly Detection、Pricing Calculator の違い。
- コスト配分タグ：ユーザー定義と AWS 生成。有効化が必要。反映に時間がかかる。過去にさかのぼらない。Organizations では管理アカウントが有効化する。
- CloudWatch の請求アラーム（`EstimatedCharges`、us-east-1）と Budgets の比較。
- コスト削減の手段：オンデマンド / Savings Plans / リザーブドインスタンス / スポット、Compute Optimizer、Trusted Advisor、アイドルリソースの停止。
- 時間課金のリソースを見分ける：パブリック IPv4、NAT Gateway、Interface Endpoint、RDS、ElastiCache。
