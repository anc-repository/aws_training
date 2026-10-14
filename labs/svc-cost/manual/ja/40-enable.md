---
step: enable
---

AWS Budgets を組み込みます。モジュールは次のものを作成します。プロジェクト予算 `cloudalbum-{{ session.env }}-project-monthly`（`Project=CloudAlbum` で絞り込み）、アカウント予算
`cloudalbum-{{ session.env }}-account-monthly`（絞り込みなし）。どちらにも「実際の支出 > 80%」と「予測支出 > 100%」の 2 段階の通知があり、通知はあなたのメールアドレスと
SNS トピック `cloudalbum-{{ session.env }}-cost` の両方に送られます。2 つの金額には**既定値がありません**。自分が負担できる範囲で決めてください。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable cost --param ProjectBudgetLimit={{ var.projectBudgetLimit }} --param AccountBudgetLimit={{ var.accountBudgetLimit }} --param AlertEmail={{ learner.inputs.notify-email }} --dry-run
```

内容を確認したら実行します。

```bash {runsOn=workstation}
scripts/module enable cost --param ProjectBudgetLimit={{ var.projectBudgetLimit }} --param AccountBudgetLimit={{ var.accountBudgetLimit }} --param AlertEmail={{ learner.inputs.notify-email }}
```
:::

プラットフォームモードでは、コマンド内の「コスト配分タグの有効化」という帯域外のステップはスキップされ、対応するプラットフォームアクション `cost-activate-tags` が案内されます。受講者の権限にはこの操作が含まれていないため、これは想定どおりです。

:::wait{typical=3 max=15}
予算とトピックのデプロイには通常 1～2 分かかります。完了直後の cost は黄色の「订阅未确认」（サブスクリプション未確認）で、メールで確認すると正常になります。コスト配分タグがまだ反映されていない場合は、ずっと黄色の
「成本分配标签 Project 尚未生效」（コスト配分タグ Project が未反映）のままです。セッション中に待っても通常は反映されないため、この黄色だけは許可されています。
:::

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.cost | {driver, status, detail}'
```

:::expected
`driver` は `budgets` です。detail には「AWS Budgets 预算 2 个（项目：本月实际 … · 预测 暂无 · 上限 …；账号：…）· 本地：当前按小时计费的资源 …」（AWS Budgets の予算 2 件（プロジェクト：今月の実績 … · 予測 なし · 上限 …、アカウント：…）· ローカル：現在の時間課金リソース …）と表示されます。
ローカルの一覧は止まっておらず、その隣に Budgets の値が加わっただけです。
:::

:::why
**なぜ予算にクレジットを含めないのでしょうか？** 新しいアカウントはクレジット制で、クレジットが請求額を相殺します。予算にクレジットを含めると、正味の支出がずっと 0 に近いままアラートが一度も鳴らず、
その間にクレジットが消費されていきます。テンプレートは `CostTypes.IncludeCredit` を false にしています。
:::

::checks
