---
step: enable-dns
---

ワンクリックスクリプトが dns スタックをデプロイします。ホストゾーン（新規作成、または `--zone-id` で指定した既存のゾーン）＋ラボ用インスタンスの Elastic IP を指す TTL 60 の A レコードです。
続いて `dns.env` をラボ用インスタンスに配置します。`APP_BASE_URL` が `http://{{ learner.inputs.domain }}` になり、メールや共有リンクにはこれ以降ドメイン名が書かれます。

:::method{kind=script default}
まず変更内容をプレビューします（リソースを変更する API は呼び出しません）。

```bash {runsOn=workstation}
scripts/module enable dns --domain {{ learner.inputs.domain }} --target eip --dry-run
```

内容を確認したら実行します。既存のホストゾーンを使う場合は `--zone-id <ホストゾーン ID>` を付けます。

```bash {runsOn=workstation}
scripts/module enable dns --domain {{ learner.inputs.domain }} --target eip
```
:::

ホストゾーンを新しく作る場合、スクリプトは 4 つのネームサーバーを表示し、委任が反映されるまでパブリックリゾルバーをポーリングします（最大 15 分。`--param DelegationWaitMin=0` でスキップ）。

:::wait{typical=5 max=30}
レジストラー（または親ドメインの DNS）で、`{{ learner.inputs.domain }}` にこの 4 つの NS レコードを追加してください。反映までの時間はレジストラーとトップレベルドメイン次第です。待っている間に考えてみましょう。
**なぜ A レコードの TTL は 60 秒なのでしょうか？** 移行の前に TTL を下げておけば古い値が早く切れ、切り替え時にユーザーが感じる中断が短くなります。
:::

委任とレコードを確認します。

```bash {runsOn=workstation}
dig +short NS {{ learner.inputs.domain }} @8.8.8.8
dig {{ learner.inputs.domain }} @8.8.8.8 | grep -A1 'ANSWER SECTION'
curl -s http://{{ learner.inputs.domain }}/api/lab/echo | jq '{host, entry}'
```

:::expected
NS は 4 つの `awsdns` ネームサーバーです。A レコードは `{{ target.publicIp }}` で、2 列目は残りの TTL（≤ 60）です。echo が返す `host` はあなたのドメイン名です。
これはサーバーが受け取った Host ヘッダーで、リクエストが確かにドメイン名経由で届いたことを示します。
:::

:::why
**dns はリクエストの経路上にはありません。** DNS が担当するのは「名前 → アドレス」だけで、リクエスト自体は今も EC2 の Nginx に直接届きます。そのため、このカードには新しいレスポンスヘッダーはありません。
代わりに検知処理がインスタンス上でドメインを解決してインスタンスの現在の Elastic IP と比較し、あわせて直近 5 分間で何件のリクエストがまだ IP でアクセスしているかを集計します。
:::

::checks
