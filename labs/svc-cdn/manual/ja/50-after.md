---
step: after
---

before と同じ負荷でもう一度測ります。今回はすべて CloudFront 経由でアクセスします（`target=cdn`）。

```bash {runsOn=workstation}
npm run exp -- cdn --label after --scenario media-load --param target=cdn --upload
```

::experiment{module=cdn id=media-load label=after}

:::expected
オリジンのリクエスト数と EC2 の送信バイト数がはっきり下がります（残るのはミスしたときのオリジンへのリクエストだけです）。レポートでは before と after の結果がどちらも「有効」と表示され、比較可能なペアとして示されます。
:::

:::saa{domain=cost}
AWS のオリジン（EC2、S3、ALB）から CloudFront へのデータ転送は無料です。ユーザーが CloudFront からダウンロードする分は CloudFront のデータ転送（アウト）として課金されます（正確な料金は公式の料金表を確認してください）。
ヒット率が高いほど、EC2 のデータ転送（アウト）は少なくなります。
:::

::checks
