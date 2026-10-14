---
step: after-bench
---

同じテストユーザーで同じ 10 個のファイルを、今度は STS の一時的な認証情報でステージングバケットに直接アップロードします。

```bash {runsOn=workstation}
npm run exp -- identity-pool --label after --scenario upload-bench --upload
npm run exp:report -- identity-pool --experiment upload-bench
```

::experiment{module=identity-pool id=upload-bench label=after}

:::expected
`mode=sts` で、`backendRequestsPerFile` はおよそ 2（登録と complete。これに加えて一括で 1 回だけ認証情報を交換）となり、パートの数には関係しません。`s3RequestsPerFile` ＝パート数 + 2
（CreateMultipartUpload、UploadPart × n、CompleteMultipartUpload）です。サーバー側の証拠：各写真はサーバー側ですでに `PROCESSING` / `READY` で、
抜き取りで確認したステージングのオブジェクトは complete の後に削除されています（サーバー側の CopyObject の後に DeleteObject）。
:::

:::tip
EC2 へのインバウンドのトラフィックは、どちらの場合もメタデータだけです。このカードの開始状態では storage がすでに S3 なので、before のパートも S3 に直接送られており、パートごとに EC2 に問い合わせていただけです。
「バイトが EC2 を通る」ベースラインを見たい場合は、storage=local の L0 で別途 `--label before --param mode=token` を実行してください（参考）。
:::

::checks
