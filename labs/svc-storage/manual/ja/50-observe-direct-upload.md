---
step: observe-direct-upload
---

アプリのプレビューで写真をさらに 3 枚アップロードし、開発者ツールで観察します。アップロードは 2 段階です。まずこのサイトに署名付き URL を求め、次にファイルを S3 に PUT します。

ワークベンチのターミナルで、オブジェクトがどこに置かれたかを確認します。

```bash {runsOn=workstation}
aws s3api list-objects-v2 --bucket {{ var.rawBucket }} --prefix raw/ --max-items 5 --query "Contents[].[Key,Size]" --output table
```

:::expected
PUT リクエストのホストは `{{ var.rawBucket }}.s3.{{ session.region }}.amazonaws.com` で、URL に `X-Amz-Signature` が付いています。
`raw/` プレフィックスの下にアップロードしたばかりのオブジェクトがあります。ラボ用インスタンスのネットワーク受信量は、アップロードしてもほとんど増えません。
:::

::checks
