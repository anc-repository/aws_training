---
step: baseline
---

**before** を記録します。ランナーが管理者として 2 人のテストユーザーの写真にランダムに 20 件のコメントを投稿し、それぞれが `comment.created` イベントを 1 件生成します。
その後、サーバーから今回のイベントの配信記録を読み取ります（`GET /api/admin/notifications/deliveries`）。

```bash {runsOn=workstation}
npm run exp -- notification --label before --scenario fanout --upload
```

::experiment{module=notification id=fanout label=before}

アプリのプレビューで管理者として `/admin/outbox` を開きます。コメントのたびに、outbox に書き込まれた通知メールが 1 通ずつ増えており、ページ上部には「邮件未真正发出（本地 outbox）」（メールは実際には送信されていない。ローカルの outbox）と表示されています。

:::expected
レポートの `deliveriesByChannel` には `email` しかなく、イベントごとに 1 行です。コメントのリクエストの Server-Timing の `notification` 区間には EmailPort の所要時間が含まれます。
2 人のユーザーの実際のメールボックスには何も届いていません。
:::

:::why
db ドライバーの所要時間は受信者数に比例して増えます。人気の写真にフォロワーが数十人いると、コメント投稿のリクエストは数十回のメール呼び出しを待つことになります（`QUEUE_DRIVER=sync` のときはすべてリクエストに含まれます）。
:::

::checks
