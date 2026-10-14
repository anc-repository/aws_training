---
section: wrap-up
---

このラボで身につけたこと：

- WAF の関連付け先（CloudFront、ALB、API Gateway REST API など）と、関連付けられないリソース（EC2、EIP、NLB）。
- CLOUDFRONT スコープの Web ACL、IP セット、ロググループはすべて **us-east-1** にあること。
- マネージドルールグループはまず Count、その後 Block。CRS の `SizeRestrictions_BODY` による大きなリクエストボディの誤検知と、その上書き。
- レートベースのルールはウィンドウで集計され検知に遅延があること、Nginx の正確なレート制限との違い。
- オリジンのロックと「WAF の迂回」、そしてブロックされた位置を**サーバー側の証拠**で判断すべき理由。
