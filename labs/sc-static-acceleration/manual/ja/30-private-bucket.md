---
step: private-bucket
---

バケットがまだプライベートであることを示します。同じオブジェクトでも、バケットに直接リクエストすると拒否され、ディストリビューション経由のリクエストは成功し、2 回目はキャッシュにヒットします。

まずアプリからサムネイルのバケット内のキー（`/media/` より後ろの部分）を取得し、`KEY` とします。

```bash {runsOn=workstation}
KEY=$(aws s3api list-objects-v2 --bucket {{ var.mediaBucket }} --prefix variants/ --max-items 1 --query "Contents[0].Key" --output text)
echo "$KEY"
```

バケットに直接リクエストします（署名なし）。

```bash {runsOn=workstation}
curl -s -o /dev/null -w "bucket: %{http_code}\n" "https://{{ var.mediaBucket }}.s3.{{ session.region }}.amazonaws.com/$KEY"
```

ディストリビューション経由で 2 回リクエストします。

```bash {runsOn=workstation}
for i in 1 2; do curl -s -o /dev/null -D - "https://{{ var.cdnDomain }}/media/$KEY" | grep -iE "^(HTTP/|x-cache|age):"; sleep 1; done
```

:::expected
バケットへの直接のリクエストは `403` を返します。ディストリビューション経由の 1 回目は `200` + `Miss from cloudfront`、2 回目は `200` + `Hit from cloudfront` です（まれに 2 回とも Miss になります。2 回の curl が別のキャッシュホストに当たることがあるので、もう一度実行してください）。
:::

:::why
**公開バケットではなく OAC。** CloudFront はサービスプリンシパル `cloudfront.amazonaws.com` として署名してオブジェクトを読み、バケットポリシーは `AWS:SourceArn` で許可をこのディストリビューションに限定します。
他のディストリビューション、他のアカウント、あらゆる直接のリクエストは拒否されます。オブジェクトが SSE-KMS を使う場合は、キーポリシーでもこのサービスプリンシパルに復号を許可する必要があります。これは OAI にはできないことです。
:::

::checks
