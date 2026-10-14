---
step: before
---

先记录起点：实验机 443 上的自签名证书。

```bash {runsOn=workstation}
npm run exp -- tls --label before --scenario inspect --upload
```

::experiment{module=tls id=inspect label=before}

:::expected
`entries` 中直连入口的 `issuer` 与 `subject` 都是 `cloudalbum-l0`，`trusted` 为 false，`kind` 为 `selfsigned`；
路径头的 `tls` 段是 `selfsigned@nginx`。
:::

再用浏览器在新标签页打开 `https://{{ target.publicIp }}/`：浏览器显示拦截页（证书无效）。这就是“加密了但不受信任”。

:::why
自签名证书的签发者就是它自己，没有任何受信任的根证书为它背书。浏览器无法确认你连上的是真的相册，所以拦截；
其他源发起的 fetch 也会失败，真实用户无法使用依赖 HTTPS 的 Cognito 回调。
:::

::checks
