---
step: after
---

after を記録します。ステップ 1 と同じメディアの読み込みですが、今回はサムネイルがエッジから返されます。

```bash {runsOn=workstation}
npm run exp -- cdn --label after --scenario media-load --upload
```

::experiment{module=cdn id=media-load label=after}

:::expected
オリジンのリクエスト数と送信バイト数が大きく下がり、残るのはミスによるオリジンリクエストだけです。`/lab` の「源站负载」（オリジンの負荷）パネルでは、`X-Amz-Cf-Id` 付きのオリジンリクエストの割合がごくわずかです。
:::

:::saa{domain=performance confusable="CloudFront vs Global Accelerator vs S3 Transfer Acceleration"}
CloudFront はエッジでコンテンツをキャッシュします。Global Accelerator は静的な Anycast IP とバックボーンネットワークによる高速化を提供しますが、キャッシュはせず、エンドポイントは ALB、NLB、EC2、Elastic IP です。
S3 Transfer Acceleration はクライアントとバケット間の長距離転送を高速化します（主にアップロード向け）が、これもキャッシュしません。
:::

::checks
