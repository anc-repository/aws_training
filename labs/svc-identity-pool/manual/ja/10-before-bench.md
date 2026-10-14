---
step: before-bench
---

まず開始状態の F14 を記録します。テストユーザー A が 12 MB の JPEG を 10 個アップロードします（パートは 8 MB、ファイルごとに 2 パート）。使うのはアプリが署名したプレフィックストークンです。

```bash {runsOn=workstation}
npm run exp -- identity-pool --label before --scenario upload-bench --upload
```

::experiment{module=identity-pool id=upload-bench label=before}

アプリのプレビューでも 1 回試してみましょう。「上传照片」（写真をアップロード）を開き、写真を 2 枚まとめて選び（複数ファイルは F14 を通ります）、ブラウザーの DevTools の Network パネルを開きます。

:::expected
レポートは `mode=token` で、`backendRequestsPerFile` はおよそ 2 ＋パート数（登録、パートごとに 1 回の `parts:sign`、complete）です。
DevTools では、各パートの前に EC2 への `POST /api/uploads/parts:sign` があり、リクエストヘッダーは `Authorization: CA-Upload …` です。
レスポンスヘッダー `X-CloudAlbum-Path` の identity-pool セグメントは `none:token` です。
:::

:::tip
トークンは URL ではなくリクエストヘッダーに入れています。そのためアクセスログにもブラウザーの履歴にも残りません。それでもアプリ独自の取り決めにすぎず、漏えいすれば有効期間内はそのユーザーのプレフィックスにファイルを書き込めてしまいます。
取り消すには、アプリが自分でブラックリストを管理する必要があります。
:::

::checks
