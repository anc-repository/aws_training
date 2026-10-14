---
step: observe-edge-cache
---

`/api/public/now` は `Cache-Control: public, s-maxage=10, max-age=0` を返し、`/api/public/*` のビヘイビアのキャッシュキーにはすべてのクエリパラメーターが含まれます。
つまり、**新しい**クエリパラメーターを付けて 2 回リクエストすると、1 回目は必ずオリジンに戻り（Miss）、10 秒以内の 2 回目はエッジから返るはずです（Hit）。

まず自分で確かめます（ワークベンチのターミナル）。

```bash {runsOn=workstation}
N=$(date +%s%N)
for i in 1 2; do
  curl -s -o /dev/null -D - "https://{{ var.cdnDomain }}/api/public/now?atlprobe=$N" \
    | grep -iE '^(x-cache|age|x-amz-cf-pop|x-cloudalbum-path):'
  sleep 1
done
echo "nonce: $N"
```

:::expected
```text
x-cache: Miss from cloudfront
x-cloudalbum-path: entry=cloudfront>nginx;inst={{ target.instanceId }};az={{ target.az }}
x-cache: Hit from cloudfront
age: 1
x-cloudalbum-path: entry=cloudfront>nginx;inst={{ target.instanceId }};az={{ target.az }}
```
2 回目の `x-cloudalbum-path` は 1 回目とまったく同じです。キャッシュされたレスポンスヘッダーそのものだからです。
まれに 2 回とも Miss になることがあります。2 回の `curl` はそれぞれ新しい接続を開くため、同じエッジロケーション内の別のキャッシュホストに振り分けられることがあるからです。もう一度実行してください。プラットフォームのチェックでは 2 回のリクエストで同じ接続を再利用します。
:::

次に**ラボ用インスタンスのターミナル**でオリジンのログを見ます。同じ `atlprobe` は **1 回だけ**現れ、ポートは 8080 です。下のコマンドの `<nonce>` を前のステップで表示された値に置き換えてください（2 つのターミナルは変数を共有しません）。

```bash {runsOn=lab vars=false}
sudo tail -n 200 /var/lib/cloudalbum/logs/nginx-access.json | grep "atlprobe=<nonce>" | jq -c '{ts, port, status, args}'
```

:::why
**なぜプラットフォームは、あなたが見たヘッダーをそのまま信じないのでしょうか？** `X-Cache` や `X-Amz-Cf-Id` はただの文字列で、オリジンの Nginx に `add_header` を 1 行書けば作れてしまいます。
そのため「チェック」を押すと、プラットフォームは自分でこの 2 回のリクエストを送り、さらに次のことを行います。
1. CloudFront API で調べた、このラボで作成したディストリビューションのドメインだけにリクエストする。
2. 相手の IP が CloudFront の公開アドレス範囲に属し、証明書が `*.cloudfront.net` であることを確認する。
3. オリジンのログでこの nonce が何回現れたかを数える。**2 回リクエストしてオリジンが 1 回しか受けていない**ことで、2 回目が本当にエッジでヒットしたと証明できます。

プラットフォームはさらに CloudFront 経由で CloudAlbum のプローブ用エンドポイント `/api/lab/probe/now`（`Cache-Control: private, no-store`）に 2 回リクエストし、認証が必要な API が 2 回ともキャッシュにヒットしないことを確認します。個人向けの API がキャッシュされると、ユーザー A のデータがユーザー B に返ってしまいます。
:::

:::saa{domain=performance confusable="浏览器缓存 vs 边缘缓存"}
`max-age` はブラウザーのキャッシュを、`s-maxage` は共有キャッシュ（CloudFront）を制御します。キャッシュポリシーの最小 TTL が 0 より大きいと、オリジンの `no-cache`/`private` は無視されます。
:::

::check{id=edge-cache-observed}
::check{id=api-not-cached}
