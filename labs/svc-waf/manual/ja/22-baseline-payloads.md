---
step: baseline-payloads
---

**before** の 2 つ目を記録します。Nginx のシグネチャによるブロックです。`payloads` は公開されている WAF のテスト用ペイロード一式（SQL インジェクションとその URL / 二重エンコード / 大文字小文字・コメントのバリエーション、ディレクトリトラバーサル、XSS、リクエストヘッダー内の Log4Shell のプローブ文字列、スキャナーの User-Agent）を送ります。

```bash {runsOn=workstation}
npm run exp -- waf --label before --scenario payloads --param target=direct
```

Nginx の数個の正規表現は、二重エンコード、大文字小文字、コメントのバリエーションを**見逃します**。これこそが Nginx の限界で、ステップ 7 で AWS マネージドルールグループと比較します。
