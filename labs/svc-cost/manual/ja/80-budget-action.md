---
step: budget-action
---

（任意）Budgets Actions は、しきい値を超えたときに IAM ポリシーや SCP のアタッチ、EC2 / RDS インスタンスの停止といったアクションを自動で実行できます。このカードでは最も安全なものだけを試します。
AWS 管理ポリシー `AWSDenyAll` を、**どのコンポーネントも使っていないカナリアロール**にアタッチするもので、アプリのロールやラボ用インスタンスを対象にすることはありません。

:::method{kind=script default}
まず変更内容をプレビューします（増えるのは予算アクション、カナリアロール、アクションの実行ロールだけです）。

```bash {runsOn=workstation}
scripts/module enable cost --param ProjectBudgetLimit={{ var.projectBudgetLimit }} --param AccountBudgetLimit={{ var.accountBudgetLimit }} --param AlertEmail={{ learner.inputs.notify-email }} --param EnableBudgetAction=true --dry-run
```

内容を確認したら実行し、アクションの設定を確認します。

```bash {runsOn=workstation}
scripts/module enable cost --param ProjectBudgetLimit={{ var.projectBudgetLimit }} --param AccountBudgetLimit={{ var.accountBudgetLimit }} --param AlertEmail={{ learner.inputs.notify-email }} --param EnableBudgetAction=true
aws budgets describe-budget-actions-for-budget --account-id {{ session.accountId }} --budget-name cloudalbum-{{ session.env }}-project-monthly
aws iam list-attached-role-policies --role-name cloudalbum-{{ session.env }}-cost-canary
```
:::

::console-link[Budgets コンソールを開く]{link=budgets.home}

:::expected
アクションのタイプは `APPLY_IAM_POLICY` で、対象ロールは `cloudalbum-{{ session.env }}-cost-canary` です。請求データが実際にしきい値を超えるまでは、カナリアロールには
まだポリシーがアタッチされていません。発動を待つ必要はありません。
:::

:::warning
Budgets Actions が Auto Scaling グループのインスタンスを停止すると、Auto Scaling はすぐに新しいインスタンスを補充します。アクションをアプリのロールに向けると、ガードレールがアプリ自身を止めてしまうおそれがあります。
このプロジェクトがアクションをカナリアロールにだけ使うのは、そのためです。
:::

::checks
