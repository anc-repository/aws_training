---
step: baseline
---

まず出発点を確認します。`waf` はインスタンス上の Nginx（`WAF_MODE=nginx`）で、`cdn` は有効になっておらず、ブラウザーも攻撃者もラボ用インスタンスの Elastic IP に直接アクセスしています。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules | {waf: .waf.driver, cdn: .cdn.driver}'
```

**before** の 1 つ目を記録します。ワークベンチから直接アクセスの入口に対して、短いラウンドのレート制限の攻撃を行います。ランナーはしきい値をわずかに上回るレートで `POST /api/auth/login`（匿名、誤ったパスワード）に送り、
1 秒ごとにステータスコードを記録し、その後管理者としてオリジンのログにおける今回の nonce の件数を読み取ります。

```bash {runsOn=workstation}
npm run exp:login -w @cloudalbum/experiments
npm run exp -- waf --label before --scenario flood --param target=direct --param rate=8 --param duration=30 --upload
```

::experiment{module=waf id=flood label=before}

:::tip
`WAF_LAB_ALLOW_CIDR` は空でなければなりません。これは Allow アクションで、許可リストのアドレスにすべてのルールをスキップさせてしまいます。このカードでは最後まで設定しません。
:::

:::expected
Nginx の `limit_req` はほぼ即座に **429** でブロックします（経路ヘッダー `waf=nginx:ratelimit`）が、ラボ用インスタンスのアクセスログにはこのラウンドのログインリクエストがすべて現れます。
拒否されたリクエストも、インスタンスの接続、TLS、ログを同じように消費しています。
:::

:::why
**「止めた」は「届いていない」ではありません。** Nginx がリクエストを拒否する前に、TCP ハンドシェイク、TLS の復号、リクエストの解析はすでに EC2 で済んでいます。攻撃量がもう少し増えれば、
Nginx 自体がボトルネックになります。このカードでは、ブロックする地点を CloudFront のエッジに移し、これらのリクエストがそもそも東京リージョンに入らないようにします。
:::

::checks
