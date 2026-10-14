---
step: switch-block
---

観察して問題がなければ、マネージドルールグループを **Block** に切り替えます。`modular-design` §9.2 には `set` サブコマンドがありません。パラメーターを 1 つ変えるとは、新しいパラメーターでもう一度 `enable` すること（スタックの更新）です。

:::method{kind=script default}
まず変更内容をプレビューします。

```bash {runsOn=workstation}
scripts/module enable waf --param RuleAction=block --dry-run
```

内容を確認したら実行します（Web ACL がマネージドルールグループのアクションを更新し、通常 1～2 分で反映されます）。

```bash {runsOn=workstation}
scripts/module enable waf --param RuleAction=block
```
:::

自分でペイロードを 1 つ送り、ラボ用インスタンスのアクセスログでそれを探してみます。

```bash {runsOn=workstation}
N=edge-$(date +%s); echo "$N"
curl -s -o /dev/null -w "%{http_code}\n" "https://{{ var.cdnDomain }}/api/public/now?q=1%27%20UnIoN%20SeLeCt%201&atlprobe=$N"
```

```bash {runsOn=lab}
sudo grep -c "atlprobe=<前のステップで表示された N>" /var/lib/cloudalbum/logs/nginx-access.json
```

:::expected
リクエストは **403** を返し、ラボ用インスタンスのアクセスログでのこの nonce の件数は **0** です。リクエストはエッジで止められ、EC2 にはまったく届いていません。
プラットフォームのチェックも、新しい nonce 付きのペイロードを自動で 1 件送り、同じ方法で照合します。
:::

:::warning
マネージドルールグループが Block したときに返るのは **CloudFront の 403 ページ**で、アプリの `X-CloudAlbum-Path` は付きません。Nginx の正規表現でブロックしたときも 403 です。
クライアントのレスポンスヘッダーだけではどの層で止めたのか区別できないので、ブロックの位置は常に**オリジンがリクエストを受け取ったかどうか**で判断します。
:::

::checks
