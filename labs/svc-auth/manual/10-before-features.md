---
step: before-features
---

记录 before：读取 `/api/capabilities` 中 auth 的公开配置与 F1～F4、F12 子功能，生成功能矩阵。

```bash {runsOn=workstation}
npm run exp -- auth --label before --scenario feature-matrix --upload
```

::experiment{module=auth id=feature-matrix label=before}

再看本地驱动的签名公钥（auth=local 时由 EC2 发布）：

```bash {runsOn=lab}
curl -s http://127.0.0.1/.well-known/jwks.json | jq ".keys[] | {kid, kty, crv, alg}"
```

:::expected
功能矩阵中注册、邮箱验证、锁定、TOTP 都由 `local` 实现；JWKS 中的密钥是 EC 曲线 P-256，`alg` 为 `ES256`。
:::

::checks
