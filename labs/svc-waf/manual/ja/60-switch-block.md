---
step: switch-block
---

観察して問題がなければ、マネージドルールグループを **Block** に切り替えます。

:::tip
`modular-design §9.2` には `set` サブコマンドがありません。「パラメーターを 1 つ変える」とは、新しいパラメーターでもう一度 `enable` することです（スタックの更新、付録 B-27）。
:::

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable waf --param RuleAction=block --dry-run
```

内容を確認したら実行します（Web ACL がマネージドルールグループのアクションを更新します）。

```bash {runsOn=workstation}
scripts/module enable waf --param RuleAction=block
```
:::

:::expected
マネージドルールグループの `OverrideAction` が `None` になります（自身の Block アクションが有効になります）。チェックは nonce 付きのペイロードを自動で 1 件送り、それが 403 を返し、**オリジンに届いていない**こと（オリジンのログでこの nonce の件数が 0）を確認します。
:::

:::warning
マネージドルールグループの Block が返すのは **CloudFront の 403** で、アプリの `X-CloudAlbum-Path` ヘッダーは付きません。そのため、クライアントのレスポンスヘッダーだけでは Nginx の正規表現による 403 と区別できません。「エッジで止まった」と判断するにはサーバー側の証拠、つまりオリジンがそのリクエストをまったく受け取っていないことが必要です。
:::
