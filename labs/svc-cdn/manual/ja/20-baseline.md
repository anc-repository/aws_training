---
step: baseline
---

CloudFront を有効にする前に、「EC2 から直接配信」しているときのオリジン負荷を記録し、比較の before にします。

ランナーは 5 分間、アルバムの JSON、30 枚のサムネイル、1 枚の表示用画像を読み込み続け、結果をプラットフォームにアップロードします。

```bash {runsOn=workstation}
npm run exp -- cdn --label before --scenario media-load --upload
```

::experiment{module=cdn id=media-load label=before}

:::expected
実行が終わると `runId` と `== cdn/media-load · before` が表示されます。プラットフォームは数十秒以内に照合を終え、チェックが「合格」になります。
:::

:::tip
実行中にラボ用インスタンスのターミナルで `sudo tail -f /var/lib/cloudalbum/logs/nginx-access.json | jq -c '{uri, status}'` を実行すると、すべてのリクエストが Nginx に届いている様子を確認できます。
:::

::checks
