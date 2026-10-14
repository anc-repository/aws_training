---
step: baseline-payloads
---

**before** の 2 つ目を記録します。Nginx のシグネチャによるブロックです。`payloads` は直接アクセスの入口に、公開されている WAF のテスト用ペイロード一式を送ります。SQL インジェクションとその URL エンコード、
二重エンコード、大文字小文字・コメントのバリエーション、ディレクトリトラバーサル、XSS、リクエストヘッダー内の Log4Shell のプローブ文字列、スキャナーの User-Agent です。

```bash {runsOn=workstation}
npm run exp -- waf --label before --scenario payloads --param target=direct --upload
```

::experiment{module=waf id=payloads label=before}

ラボ用インスタンスで、Nginx がどんなルールを使っているかを見てみます。

```bash {runsOn=lab}
grep -n 'ca_block' -A3 /etc/nginx/conf.d/cloudalbum.conf | head -8
```

:::expected
最も素朴な `union select`、`<script`、`../` は Nginx が 403 でブロックします。二重エンコードや、大文字小文字を混ぜてコメントを入れたバリエーションはそのままアプリに届きます。
これらの見逃されたバリエーションは、ステップ 9 で AWS マネージドルールグループと比較します。
:::

::checks
