---
step: orient
---

まず開始状態を確認します。`waf` はまだローカル実装（`WAF_MODE=nginx`）で、`cdn` は有効ですが、直接アクセスの入口は**ロックされていません**（`CDN_DIRECT_ACCESS=open`）。
これは意図的で、ステップ 2、3 で「WAF を迂回できる」ことを自分の目で確かめるためです。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules | {waf: .waf.driver, cdn: .cdn.driver}'
```

このカードの WAF は **CloudFront** に付けます（CLOUDFRONT スコープ）。Web ACL、IP セット、ロググループはすべて **us-east-1** にあり、東京のアプリのリージョンとは別です。

:::expected
`waf` のドライバーは `nginx`、`cdn` のドライバーは `cloudfront` です。つまりレート制限とブロックはまだインスタンス上で行われており、エッジにはまだ WAF がありません。
:::
