---
step: bypass-before
---

オリジンはまだロックされていないので、まず「迂回できるか」を確認します。`bypass` はラボ用インスタンスの直接アクセスの入口と 8080 に直接リクエストします。

```bash {runsOn=workstation}
npm run exp -- waf --label before --scenario bypass
```

この時点では直接アクセスで到達できます（`originLocked=false`）。後で WAF を CloudFront に付けても、攻撃者は EC2 に直接リクエストして迂回できてしまいます。これこそ **DEP-018** が警告している現象で、ステップ 4 で直します。
