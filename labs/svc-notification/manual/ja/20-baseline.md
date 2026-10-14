---
step: baseline
---

before を記録します。ランナーが管理者としてテストユーザー 3 人の写真にランダムに 20 件のコメントを投稿し、それぞれが `comment.created` イベントを 1 件生成します。
その後、サーバーから今回のイベントの配信記録を読み取ります（`GET /api/admin/notifications/deliveries`）。

```bash {runsOn=workstation}
npm run exp -- notification --label before --scenario fanout --upload
```

::experiment{module=notification id=fanout label=before}

アプリの `/admin/outbox` を開きます。コメントのたびに、outbox に書き込まれた通知メールが 1 通ずつ増えています（このカードの開始状態では email は outbox で、実際には送信されません）。

:::expected
レポートの `deliveriesByChannel` には `email` しかなく、イベントごとに 1 行です。コメントのリクエストの Server-Timing の `notification` 区間には EmailPort の所要時間
（`email` 区間）が含まれます。
:::

:::tip
db ドライバーの所要時間は受信者数に比例して増えます。1 件の「管理者向けブロードキャスト」はすべての管理者に 1 通ずつ送られます。機能比較用のエンドポイント `/api/lab/notification/compare`
が使える場合は、レポートに `broadcast_db_email_calls`（= 管理者の人数）も表示されます。
:::

::checks
