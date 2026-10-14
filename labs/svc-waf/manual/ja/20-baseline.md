---
step: baseline
---

**before** を記録します。Nginx だけによるレート制限とシグネチャによるブロックです。ワークベンチから**直接アクセス**の入口に向けて、短いラウンドの実験を 2 つ実行します。

:::tip
`WAF_LAB_ALLOW_CIDR` は空でなければなりません。これは Allow アクションで、許可リストのアドレスにすべてのルールをスキップさせてしまいます（waf 自身の実験では意味がありません）。
:::

```bash {runsOn=workstation}
npm run exp -- waf --label before --scenario flood --param target=direct --param rate=8 --param duration=30
npm run exp -- waf --label before --scenario payloads --param target=direct
```

- `flood`：1 つの送信元からしきい値をわずかに上回るレートで `POST /api/auth/login` に送ります。Nginx の `limit_req` はほぼ即座に **429** でブロックします（経路ヘッダー `waf=nginx:ratelimit`）が、どのリクエストもインスタンスに届いています。
- `payloads`：公開されている WAF のテスト用ペイロードの一式です。Nginx の数個の正規表現は、二重エンコード、大文字小文字、コメントのバリエーションを**見逃す**ことに注目してください。
