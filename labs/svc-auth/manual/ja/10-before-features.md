---
step: before-features
---

before を記録します。`/api/capabilities` から auth の公開設定と F1～F4、F12 のサブ機能を読み取り、機能マトリクスを作ります。

```bash {runsOn=workstation}
npm run exp -- auth --label before --scenario feature-matrix --upload
```

::experiment{module=auth id=feature-matrix label=before}

次に、ローカルドライバーの署名用公開鍵を見ます（auth=local のときは EC2 が公開しています）。

```bash {runsOn=lab}
curl -s http://127.0.0.1/.well-known/jwks.json | jq ".keys[] | {kid, kty, crv, alg}"
```

:::expected
機能マトリクスでは、登録、メールアドレスの確認、ロック、TOTP がすべて `local` で実装されています。JWKS のキーは楕円曲線 P-256 で、`alg` は `ES256` です。
:::

::checks
