---
step: compression
---

（选做）比较文本资源直连与经 CloudFront 时的压缩：

```bash {runsOn=workstation}
npm run exp -- cdn --label after --scenario compression --upload
```

::experiment{module=cdn id=compression label=after}

:::expected
经 CloudFront 的 JS、CSS 带 `Content-Encoding: br`，传输字节少于直连时的 gzip。HTTP/2、HTTP/3 的差别请在浏览器开发者工具的
“Protocol”列中观察（Node 的 http 模块只说 HTTP/1.1）。
:::

::checks
