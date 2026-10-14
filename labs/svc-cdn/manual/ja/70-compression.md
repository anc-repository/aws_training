---
step: compression
---

（任意）テキスト系リソースを直接取得した場合と CloudFront 経由の場合とで、圧縮を比べます。

```bash {runsOn=workstation}
npm run exp -- cdn --label after --scenario compression --upload
```

::experiment{module=cdn id=compression label=after}

:::expected
CloudFront 経由の JS と CSS には `Content-Encoding: br` が付き、転送バイト数は直接取得したときの gzip より少なくなります。HTTP/2 と HTTP/3 の違いは、ブラウザーの開発者ツールの
「Protocol」列で確認してください（Node の http モジュールは HTTP/1.1 しか扱いません）。
:::

::checks
