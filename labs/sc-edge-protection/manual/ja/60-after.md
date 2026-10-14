---
step: after
---

**after** を記録します。ステップ 1 と同じレート制限の攻撃を、今回は 2 つの経路に同時に送ります。直接アクセス（ワークベンチは管理者 IP なのでまだ到達でき、並べて比較するために使います）と、CloudFront 経由のエッジの入口です。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario flood --param target=both --param rate=8 --param duration=30 --upload
npm run exp:report -- waf
```

::experiment{module=waf id=flood label=after}

:::expected
- **直接アクセス**：相変わらず Nginx の 429 で、ほぼ即座に効き、どのリクエストもインスタンスに記録されます。
- **エッジ**：最初の数十秒のリクエストはそのまま通り（レートベースのルールは評価ウィンドウで集計され、検知に遅延があります）、その後 `rate-login` によって 429 でブロックされます（経路ヘッダー `waf=aws:block-rate-login`）。
  ブロックされた分はオリジンのログに現れなくなり、攻撃中にオリジンが受け取るリクエスト数は安定しています。
:::

:::saa{domain=resilient confusable="Nginx limit_req vs WAF 速率规则"}
`limit_req` は秒単位で正確で、インスタンスごとに別々に数えます（インスタンスが複数あると上限が実質的に増えます）。WAF のレートベースのルールはエッジでウィンドウごとに集計し、全体で数え、検知に遅延があり、
CloudFront の背後では実際のクライアント IP（または `X-Forwarded-For`）で集計します。この 2 つはよく組み合わせて使います。エッジで大部分を止め、オリジンで最後の砦を担います。
:::

::checks
