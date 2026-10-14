---
step: orient
---

アプリのプレビューでアルバムを開き、ブラウザーの開発者ツールの Network パネルでサムネイルのリクエストを確認します。ホストは `cloudalbum-{{ session.env }}-storage-media-…s3.{{ session.region }}.amazonaws.com` で、
URL には `X-Amz-Signature` などの署名パラメーターが付いており、再読み込みするたびに URL が変わります。

次に before を記録します。ランナーが 5 分間、アルバムの JSON、30 枚のサムネイル、1 枚の表示用画像を読み込み続けます。

```bash {runsOn=workstation}
npm run exp -- cdn --label before --scenario media-load --upload
```

::experiment{module=cdn id=media-load label=before}

:::expected
サムネイルの 1 枚 1 枚が S3 への 1 回のリクエストです。レポートのオリジンのリクエスト数はアクセス数に比例します。
:::

:::tip
任意：`npm run exp -- cdn --label before --scenario ttfb --upload` で最初のバイトまでの時間を記録できますが、参考程度です（ワークベンチとラボ用インスタンスはどちらも東京にあります）。
:::

::checks
