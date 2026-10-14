---
step: after
---

after を記録します。同じ 4 つのアドレスに、今度は SES からメールを送ります。ランナーは、各メールの配信状態がフィードバックイベントで更新されるまで `/api/admin/outbox` をポーリングします（最大 3 分）。

```bash {runsOn=workstation}
npm run exp -- email --label after --scenario send-matrix --param to={{ learner.inputs.ses-identity }} --upload
npm run exp:report -- email
```

::experiment{module=email id=send-matrix label=after}

アプリの `/admin/outbox` を開きます。各行には transport、SES の MessageId、配信状態のバッジ（已投递 / 退信 / 投诉＝配信済み / バウンス / 苦情）があります。
`bounce@simulator.amazonses.com` に対応するユーザーの `email_status` は `bounced` になりました。今後このユーザーに送るのは、確認とパスワード再設定という 2 種類の必須のメールだけです。

:::why
**なぜバウンスと苦情を処理する必要があるのでしょうか？** バウンス率や苦情率が高すぎると、アカウントが審査され、送信が停止されることさえあります（しきい値は公式ドキュメントを確認してください）。フィードバックイベントは
設定セット → SNS → SQS で還流し、アプリが自分から取りに行くため、インバウンドのポートは不要です。設定セットレベルとアカウントレベルの抑制リストが 2 段目の保護になります。
:::

:::expected
before はすべて `outbox / none` です。after では success → `delivered`、bounce → `bounced`、complaint → `complained` となり、あなたのメールボックスに「パスワードの再設定」のメールが届きます。
フィードバック DLQ は 0 です。
:::

:::tip
機能の比較（参考）：`npm run exp -- email --label after --scenario compare --param to={{ learner.inputs.ses-identity }}` は
`POST /api/lab/email/compare` を呼び出し、同じメールを outbox と SES で 1 回ずつ送って、所要時間を並べて表示します（エンドポイントは統合フェーズで登録されます。404 が返った場合はスキップしてください）。
:::

::checks
