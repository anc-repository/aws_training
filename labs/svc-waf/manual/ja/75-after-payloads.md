---
step: after-payloads
---

**after** の 2 つ目を記録します。同じペイロード一式をエッジ（AWS WAF 経由）に向けて送り、ステップ 3 の before と組にします。

```bash {runsOn=workstation}
npm run exp -- waf --label after --scenario payloads --param target=both
```

AWS マネージドルールグループは、Nginx の数個の正規表現よりもエンコードのバリエーションの識別に強いです。結果の `caughtOnlyByWaf` に、Nginx が見逃して WAF がブロックしたバリエーションが並びます。
