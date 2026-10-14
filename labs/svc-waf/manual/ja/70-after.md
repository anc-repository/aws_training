---
step: after
---

**after** を記録します。同じ攻撃をエッジ（WAF 経由）に向けて行い、ステップ 2 の before と組にします。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario flood --param target=both --param rate=8 --param duration=30
npm run exp -- waf --label after --scenario payloads --param target=both
```

比較のポイント：

- **レート制限**：Nginx は秒単位で、ほぼ即座に、burst も正確です。AWS WAF は評価ウィンドウで集計され、検知に遅延（数十秒）があり、通過する数はしきい値と正確に一致するとは限りません。
- **オリジンの負荷**：攻撃中、CloudFront の入口を経由してオリジンに届くリクエスト数は安定しています。ブロックされたリクエストはオリジンに届きません。
- **ペイロードの識別**：AWS マネージドルールグループは、Nginx の数個の正規表現よりもエンコードのバリエーションの識別に強いです（`caughtOnlyByWaf` に、Nginx が見逃して WAF がブロックしたバリエーションが並びます）。
