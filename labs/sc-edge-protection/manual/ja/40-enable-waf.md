---
step: enable-waf
---

AWS WAF をディストリビューションに付けます。モジュールは **us-east-1** に Web ACL（CLOUDFRONT スコープ）、IP セット `cloudalbum-blocklist`、ロググループ
`{{ var.logGroup }}` を作成し、`WebAclArn` を cdn スタックに注入します。それに伴ってディストリビューションが再デプロイされます。マネージドルールグループはまず **Count**（カウントのみでブロックしない）にします。

:::method{kind=script default}
まず変更内容をプレビューします（スタック名 `cloudalbum-{{ session.env }}-waf-edge` とリージョン us-east-1 に注目してください）。

```bash {runsOn=workstation}
scripts/module enable waf --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable waf
```
:::

:::wait{typical=6 max=20}
まず us-east-1 に Web ACL をデプロイし、次に cdn スタックを更新します。ディストリビューションの再デプロイが終わるまで、waf は一時的に「Web ACL 未关联？」（Web ACL が関連付けられていない？）と表示することがあります。これは想定どおりの待機です。
:::

有効化のスクリプトは、インスタンス上の `denylist.conf` を IP セットに初回の全件インポートも行います。完了したらラボ用インスタンスで状態を確認し、ワークベンチからディストリビューション経由で 1 回リクエストします。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.waf | {driver, status, detail}'
```

```bash {runsOn=workstation}
curl -sI "https://{{ var.cdnDomain }}/api/health/live" | grep -i "^x-cloudalbum-path:"
```

WAF コンソール（リージョンは **Global (CloudFront)** を選択）で、ルールの順序、各ルールの WCU、「サンプリングされたリクエスト」を見てみましょう。

::console-link[WAF の Web ACL 一覧を開く]{link=wafv2.webAcls}

:::expected
waf は「正常」です（オリジンはすでにロックされており、DEP-018 はありません）。経路ヘッダーは `entry=cloudfront>waf>nginx` で始まります。Web ACL のデフォルトアクションが、許可したリクエストに
`x-amzn-waf-cloudalbum` を挿入し、Nginx はそれをもとに入口チェーンに waf を書き込みます。ディストリビューションの WebACLId は、このセッションの Web ACL の ARN です。
:::

:::saa{domain=secure confusable="WAF 的两种范围"}
CLOUDFRONT スコープの Web ACL、IP セット、ルールグループはすべて us-east-1 にしか作れません。REGIONAL スコープ（ALB、API Gateway、AppSync、Cognito User Pool）は、
リソースのあるリージョンに作ります。ap-northeast-1 に作った Web ACL は、ディストリビューションのドロップダウンには表示されません。
:::

::checks
